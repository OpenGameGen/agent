/** One operator-facing free model backed by anonymous adapter routes and silent retries. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo,
  type LlmImageRequestPricing, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { estimateContent, ROLE_OVERHEAD } from '@deepseek-ai/dsh-token-meter/estimate'
import { createCooldowns } from './free-model-cooldowns.ts'
import type { Config as RecoveryConfig } from './free-models.ts'

export const name = 'product-free-auto'
export const inject = ['llm', 'storageDomain']
export const AUTO_PROVIDER = 'free-auto'
export const AUTO_MODEL = 'free-auto'

/** Explicit deployment policy; messages and tools are forwarded unchanged. */
export interface Config {
  recovery: RecoveryConfig
  routeMs: number
  maxBufferBytes: number
  hiddenProviders: readonly string[]
}

/** Register a logical model; the original provider stays available to internal services. */
export class FreeAutoAdapter extends LlmAdapter {
  private preferred: string | undefined
  private models: LlmResolvedModelInfo[] = []
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<void>>()
  private readonly cooldowns: ReturnType<typeof createCooldowns>

  /** @param ctx - Public model and storage services. @param config - Anonymous candidate policy. */
  constructor(private readonly ctx: Context, private readonly config: Config) {
    super()
    this.cooldowns = createCooldowns(ctx, config.recovery.provider)
  }

  override providerInfo(provider: string) { return { id: provider, name: AUTO_MODEL } }
  override listModels(provider: string): Promise<LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: AUTO_MODEL, name: AUTO_MODEL }])
  }

  private async candidates(signal: AbortSignal): Promise<LlmResolvedModelInfo[]> {
    const config = this.config.recovery, pattern = new RegExp(config.anonymousModelPattern, 'u')
    const list = async () => (await this.ctx.llm.listModels(config.provider)).filter(model => pattern.test(model.id)
      || config.anonymousModelIds.includes(model.id) || config.anonymousModelNamePrefixes.some(prefix => model.name.startsWith(prefix)))
    let models = await list()
    if (models.length === 0) {
      await this.ctx.llm.discoverModels(config.settingsNamespace, { provider: config.provider },
        AbortSignal.any([signal, AbortSignal.timeout(config.discoveryTimeoutMs)]))
      models = await list()
    }
    const rank = (id: string) => id === this.preferred ? -1 : (() => {
      const index = config.fallbackPriorityIds.indexOf(id)
      return index < 0 ? config.fallbackPriorityIds.length : index
    })()
    models.sort((a, b) => rank(a.id) - rank(b.id))
    const resolved = await Promise.allSettled(models.map(model => this.ctx.llm.resolveModelInfo(config.provider, model.id, signal)))
    signal.throwIfAborted()
    this.models = resolved.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    return this.models
  }

  override async resolveModel(provider: string, model: string, caller?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (model !== AUTO_MODEL) throw new LlmError('Unknown automatic model', 'UNKNOWN_MODEL')
    const signal = caller ? AbortSignal.any([caller, this.lifetime.signal]) : this.lifetime.signal
    // Keep the logical selection available even during a service outage; dispatch reports exhaustion.
    let models: LlmResolvedModelInfo[]
    try { models = await this.candidates(signal) }
    catch (_error) { signal.throwIfAborted(); models = this.models }
    const contexts = models.flatMap(entry => entry.context ? [entry.context.contextWindow] : [])
    const limits = models.flatMap(entry => entry.defaultMaxTokens ? [entry.defaultMaxTokens] : [])
    return { provider, id: model, name: AUTO_MODEL,
      // Keep image blocks intact until routing can require a compatible candidate.
      inputModalities: ['text', 'image'],
      ...contexts.length ? { context: { contextWindow: Math.max(...contexts) } } : {},
      ...limits.length ? { defaultMaxTokens: Math.min(...limits) } : {},
    }
  }

  override imageRequestPricing(): LlmImageRequestPricing | undefined {
    const prices = this.models.filter(model => model.inputModalities?.includes('image'))
      .flatMap((model) => {
        const pricing = this.ctx.llm.imageRequestPricing(this.config.recovery.provider, model.id)
        return pricing ? [pricing] : []
      })
    if (!prices.length) return undefined
    return { priceImages: (images) => {
      const sets = prices.map(pricing => pricing.priceImages(images))
      return images.map((_image, index) => sets.map(set => set[index]).filter(item => item !== undefined)
        .sort((a, b) => b.visualTokens + estimateContent([{ type: 'text', text: b.text }])
          - a.visualTokens - estimateContent([{ type: 'text', text: a.text }]))[0] ?? { visualTokens: 0, text: '' })
    } }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal
    let complete: (() => void) | undefined
    const settled = new Promise<void>((resolve) => { complete = resolve })
    this.active.add(settled)
    try {
      await this.cooldowns.load(signal)
      const candidates = await this.candidates(signal)
      const images = options.messages.flatMap(message => message.content.filter(block => block.type === 'image'))
      const hasImages = images.some(image => image.offloaded !== true)
      const structural = options.messages.reduce((sum, message) => sum + ROLE_OVERHEAD + estimateContent(message.content), 0)
        + Math.ceil(JSON.stringify(options.tools ?? []).length / 4)
      for (const candidate of candidates) {
        signal.throwIfAborted()
        if ((this.cooldowns.times.get(candidate.id) ?? 0) > Date.now()) continue
        if (hasImages && !candidate.inputModalities?.includes('image')) continue
        const pricing = this.ctx.llm.imageRequestPricing(this.config.recovery.provider, candidate.id)
        if (hasImages && !pricing) continue
        const visual = pricing?.priceImages(images).reduce((sum, item) => sum + item.visualTokens
          + estimateContent([{ type: 'text', text: item.text }]), 0) ?? 0
        const output = options.maxTokens ?? candidate.defaultMaxTokens ?? 0
        if (candidate.defaultMaxTokens !== undefined && output > candidate.defaultMaxTokens) continue
        if (candidate.context && Math.ceil((structural + visual) * this.config.recovery.contextSafetyRatio)
          + output > candidate.context.contextWindow) continue
        const attempt = AbortSignal.any([signal, AbortSignal.timeout(this.config.routeMs)])
        const chunks: StreamChunk[] = []
        let bytes = 0, finished = false, answer = false
        try {
          for await (const chunk of this.ctx.llm.stream({ ...options, provider: this.config.recovery.provider,
            model: candidate.id, signal: attempt })) {
            attempt.throwIfAborted()
            if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
              throw new LlmError('Free route failed', chunk.reason.failure.code, {
                ...chunk.reason.failure.providerRetryAfterMs === undefined
                  ? {} : { providerRetryAfterMs: chunk.reason.failure.providerRetryAfterMs },
              })
            }
            if (chunk.type === 'text-delta' && chunk.text.trim() || chunk.type === 'tool-call-delta') answer = true
            if (chunk.type === 'block-end' && (chunk.block.type === 'text' && chunk.block.text.trim() || chunk.block.type === 'tool-call')) answer = true
            if (chunk.type === 'finish') finished = chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls'
              || chunk.reason.kind === 'max-tokens'
            bytes += Buffer.byteLength(JSON.stringify(chunk))
            if (bytes > this.config.maxBufferBytes) throw new LlmError('Free response exceeded buffering budget', 'FREE_AUTO_RESPONSE_LIMIT')
            chunks.push(chunk)
          }
          if (!finished || !answer) throw new LlmError('No completed free response', 'EMPTY_RESPONSE')
          this.preferred = candidate.id
          yield* chunks
          return
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof LlmError && error.failure.providerRetryAfterMs !== undefined) {
            await this.cooldowns.remember(candidate.id, Date.now() + error.failure.providerRetryAfterMs, signal)
          }
          // Failed partial output remains internal, so the next route cannot mix answers or execute stale tools.
        }
      }
      throw new LlmError('所有免费模型当前均不可用，请稍后重试。', 'FREE_MODEL_UNAVAILABLE')
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof LlmError && error.code === 'FREE_MODEL_UNAVAILABLE') throw error
      throw new LlmError('免费模型通道当前不可用，请检查网络后重试。', 'FREE_MODEL_UNAVAILABLE')
    } finally { complete?.(); this.active.delete(settled) }
  }

  /** Stop and await every outstanding route. */
  async dispose(): Promise<void> { this.lifetime.abort(); await Promise.allSettled([...this.active]) }
}

/** Mount the alias, hide internal anonymous groups, and migrate only free defaults. */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.routeMs) || config.routeMs < 1000 || !Number.isSafeInteger(config.maxBufferBytes)
    || config.maxBufferBytes < 1024) throw new Error('Invalid free-auto budgets')
  const adapter = new FreeAutoAdapter(ctx, config)
  ctx.effect(() => ctx.llm.registerAdapter([AUTO_PROVIDER], adapter))
  ctx.effect(() => () => adapter.dispose())
  const automatic = new WeakSet<Agent>()
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (typeof assembly.variables.provider !== 'string'
      || !config.hiddenProviders.includes(assembly.variables.provider) && assembly.variables.provider !== AUTO_PROVIDER) {
      if (agent) automatic.delete(agent)
      return assembly
    }
    if (agent) {
      if (!automatic.has(agent) && config.hiddenProviders.includes(assembly.variables.provider)) {
        agent.session.append('model/selection', { provider: AUTO_PROVIDER, model: AUTO_MODEL })
      }
      automatic.add(agent)
    }
    return { ...assembly, variables: { ...assembly.variables, provider: AUTO_PROVIDER, model: AUTO_MODEL } }
  }, { prepend: true })
  ctx.on('agent/request', async (_payload, next) => {
    const request = await next()
    if (!config.hiddenProviders.includes(request.provider) && request.provider !== AUTO_PROVIDER) return request
    const { reasoningEffort: _effort, ...controls } = request
    return { ...controls, provider: AUTO_PROVIDER, model: AUTO_MODEL }
  }, { prepend: true })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!automatic.has(agent) || decision.kind === 'reject') return decision
    return { ...decision, messages: decision.messages.filter(message => message.source.kind !== 'model-selection') }
  }, { prepend: true })
  ctx.on('session/model-catalog', async (_catalog, next) => {
    const catalog = await next()
    const groups = catalog.groups.filter(group => !config.hiddenProviders.includes(group.id))
    return { ...catalog, groups, routableProviders: groups.map(group => group.id),
      failures: catalog.failures.filter(failure => !config.hiddenProviders.includes(failure.id)),
      default: config.hiddenProviders.includes(catalog.default.provider)
        ? { provider: AUTO_PROVIDER, model: AUTO_MODEL } : catalog.default }
  })
  ctx.inject(['agentDefaultModel'], (child) => {
    const current = child.agentDefaultModel.currentSelection()
    if (config.hiddenProviders.includes(current.provider)) {
      void child.agentDefaultModel.saveSelection({ provider: AUTO_PROVIDER, model: AUTO_MODEL })
        .catch((_error: unknown) => { child.logger.warn('Could not persist free-auto default') })
    }
  })
}
