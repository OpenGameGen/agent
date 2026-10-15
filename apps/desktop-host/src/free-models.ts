/** Product recovery policy for the separately distributed anonymous model plugin. */
import { createCooldowns } from './free-model-cooldowns.ts'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { setTimeout as wait } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError, type ToolSchema, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-projection'

export const name = 'product-free-model-recovery'
export const inject = ['llm', 'agents', 'tokenMeter', 'sessionProjections', 'storageDomain']

/** Bounds model switching after the provider's own transient retries. */
export interface Config {
  /** Plugin-owned anonymous provider route. */
  provider: string
  /** Explicit provider-evidenced per-route request windows; absent means no throttling. */
  routeLimits?: readonly { model: string; requests: number; windowMs: number }[]
  /** Pattern accepted for anonymously callable model ids. */
  anonymousModelPattern: string
  /** Additional anonymously callable ids without a free marker. */
  anonymousModelIds: readonly string[]
  /** Trusted anonymous channel names published by the pinned plugin. */
  anonymousModelNamePrefixes: readonly string[]
  /** Preferred fallback ids; remaining candidates keep catalog order. */
  fallbackPriorityIds: readonly string[]
  /** Margin applied to the token meter's estimated input pressure. */
  contextSafetyRatio: number
  /** Maximum alternate models attempted per agent step. */
  maxSwitches: number
  /** Maximum cold-catalog discovery wait in milliseconds. */
  discoveryTimeoutMs: number
  /** Discovery registration owned by the external plugin. */
  settingsNamespace: string
  /** Provider failure codes eligible for switching after ordinary retries. */
  failureCodes: readonly string[]
  /** Explicit provider messages for retired or unavailable models. */
  unavailableMessages: readonly string[]
}

/**
 * Validate deployment settings read from the packaged product resource.
 * @param value Parsed JSON from the deployment resource.
 * @returns Complete recovery settings or a configuration error.
 */
export function parseConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) throw new Error('free-model recovery: expected configuration object')
  const record = value as Record<string, unknown>
  const fields = ['provider', 'settingsNamespace', 'anonymousModelPattern'] as const
  const lists = ['anonymousModelIds', 'anonymousModelNamePrefixes', 'fallbackPriorityIds', 'failureCodes', 'unavailableMessages'] as const
  for (const field of fields) {
    if (!(field in record) || typeof record[field] !== 'string' || !record[field]) throw new Error(`free-model recovery: invalid ${field}`)
  }
  for (const field of lists) {
    if (!(field in record) || !Array.isArray(record[field]) || record[field].some(item => typeof item !== 'string')) throw new Error(`free-model recovery: invalid ${field}`)
  }
  if (!('maxSwitches' in value) || typeof value.maxSwitches !== 'number' || !Number.isInteger(value.maxSwitches) || value.maxSwitches < 0
    || !('discoveryTimeoutMs' in value) || typeof value.discoveryTimeoutMs !== 'number' || !Number.isInteger(value.discoveryTimeoutMs) || value.discoveryTimeoutMs <= 0) {
    throw new Error('free-model recovery: invalid recovery limits')
  }
  if (!('contextSafetyRatio' in value) || typeof value.contextSafetyRatio !== 'number' || !Number.isFinite(value.contextSafetyRatio) || value.contextSafetyRatio < 1) throw new Error('free-model recovery: invalid contextSafetyRatio')
  if (record.routeLimits !== undefined) {
    if (!Array.isArray(record.routeLimits)) throw new Error('free-model recovery: invalid routeLimits')
    const ids = new Set<string>()
    for (const item of record.routeLimits as unknown[]) {
      if (typeof item !== 'object' || item === null || !('model' in item) || typeof item.model !== 'string' || !item.model.trim()
        || !('requests' in item) || typeof item.requests !== 'number' || !Number.isSafeInteger(item.requests) || item.requests < 1 || item.requests > 1000
        || !('windowMs' in item) || typeof item.windowMs !== 'number' || !Number.isSafeInteger(item.windowMs) || item.windowMs < 1000 || item.windowMs > 3600000
        || ids.has(item.model)) throw new Error('free-model recovery: invalid routeLimits entry')
      ids.add(item.model)
    }
  }
  // The loops validate named JSON fields; the interface carries the same complete field set.
  return value as Config
}

/** Install a Host-wide route gate through the public stream middleware, including title calls.
 * @param ctx Owning plugin context.
 * @param provider Exact provider to pace.
 * @param limits Only routes with explicitly configured limits.
 */
export function installRouteThrottle(ctx: Context, provider: string, limits: NonNullable<Config['routeLimits']>): void {
  const lifetime = new AbortController()
  const windows = new Map(limits.map(limit => [limit.model, { ...limit, starts: [] as number[] }]))
  ctx.effect(() => () => { lifetime.abort(); windows.clear() })
  ctx.on('llm/stream', async function* (options, next) {
    const route = options.provider === provider ? windows.get(options.model) : undefined
    if (route !== undefined) {
      const signal = options.signal === undefined ? lifetime.signal : AbortSignal.any([options.signal, lifetime.signal])
      for (;;) {
        signal.throwIfAborted()
        const now = Date.now()
        route.starts = route.starts.filter(start => now - start < route.windowMs)
        const last = route.starts.at(-1)
        const first = route.starts[0]
        const spacing = last === undefined ? 0 : last + Math.ceil(route.windowMs / route.requests) + 1 - now
        const window = route.starts.length < route.requests || first === undefined ? 0 : first + route.windowMs + 1 - now
        const delay = Math.max(spacing, window)
        if (delay <= 0) { route.starts.push(now); break }
        await wait(delay, undefined, { signal })
      }
    }
    yield* next()
  })
}

interface RouteState {
  turn: number
  step: number
  model: string
  requestedModel: string
  tried: Set<string>
  capabilityRejected: Set<string>
  switches: number
  retryNotBefore: Map<string, number>
}

/**
 * Select advertised anonymous models and recover through durable loop attempts.
 * @param ctx Plugin context; listeners unwind with the owning fiber.
 * @param config Anonymous route and finite recovery limits.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.provider || !Number.isInteger(config.maxSwitches) || config.maxSwitches < 0
    || !Number.isInteger(config.discoveryTimeoutMs) || config.discoveryTimeoutMs <= 0 || !config.settingsNamespace) {
    throw new Error('free-model recovery: invalid provider or maxSwitches')
  }
  const cooldowns = createCooldowns(ctx, config.provider)
  installRouteThrottle(ctx, config.provider, config.routeLimits ?? [])
  const lifetime = new AbortController()
  // Read dynamically after awaits; TypeScript otherwise retains an earlier false narrowing.
  const aborted = (signal: AbortSignal): boolean => signal.aborted
  ctx.effect(() => () => { lifetime.abort(new Error('free-model recovery unloaded')) })
  const anonymousPattern = new RegExp(config.anonymousModelPattern, 'u')
  const anonymous = (model: { id: string; name: string }) => anonymousPattern.test(model.id) || config.anonymousModelIds.includes(model.id)
    || config.anonymousModelNamePrefixes.some(prefix => model.name.startsWith(prefix))
  const listModels = async () => (await ctx.llm.listModels(config.provider)).filter(anonymous)
  const discover = async (signal: AbortSignal) => {
    const discoverySignal = AbortSignal.any([signal, AbortSignal.timeout(config.discoveryTimeoutMs)])
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const reason: unknown = discoverySignal.reason
        reject(reason instanceof Error ? reason : new Error('Free-model discovery aborted', { cause: reason }))
      }
      discoverySignal.addEventListener('abort', abort, { once: true })
      if (discoverySignal.aborted) { abort(); return }
      ctx.llm.discoverModels(config.settingsNamespace, { provider: config.provider }, discoverySignal)
        .then(() => { resolve() }, reject)
        .finally(() => { discoverySignal.removeEventListener('abort', abort) })
    })
  }
  // Refresh a retired default through the public settings service after discovery.
  ctx.inject(['agentDefaultModel'], (child) => {
    const syncDefault = async () => {
      const current = child.agentDefaultModel.currentSelection()
      if (current.provider !== config.provider) return
      let models = await listModels()
      if (models.some(model => model.id === current.model)) return
      await discover(lifetime.signal)
      models = await listModels()
      if (models.length === 0 || models.some(model => model.id === current.model)) return
      const latest = child.agentDefaultModel.currentSelection()
      if (aborted(lifetime.signal) || latest.provider !== current.provider || latest.model !== current.model) return
      await child.agentDefaultModel.saveSelection({ provider: config.provider, model: models[0]?.id ?? current.model })
    }
    let syncing = false
    const update = () => {
      if (syncing || aborted(lifetime.signal)) return
      syncing = true
      void syncDefault().catch((error: unknown) => { ctx.logger.warn('free-model default update failed: %s', String(error)) })
        .finally(() => { syncing = false })
    }
    child.on('llm/adapters-updated', update)
    update()
  })
  const states = new WeakMap<Agent, RouteState>()
  const assembledSelections = new WeakMap<Agent, { provider: unknown; model: unknown; tools: ToolSchema[] }>()
  const pendingImages = new WeakMap<Agent, { turn: number; step: number; messages: UserMessage[] }>()
  const noticeScopes = new WeakSet<Agent>()
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined) return assembly
    if (!noticeScopes.has(agent)) {
      ctx.effect(() => agent.ctx.on('agent/pre-step', retainedNotice, { prepend: true }))
      noticeScopes.add(agent)
    }
    const selected = { provider: assembly.variables.provider, model: assembly.variables.model, tools: assembly.tools }
    assembledSelections.set(agent, selected)
    const state = states.get(agent)
    const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (state === undefined || boundary?.openTurnStartSeq == null || boundary.lastTurn !== state.turn
      || selected.provider !== config.provider || selected.model !== state.requestedModel) return assembly
    return { ...assembly, variables: { ...assembly.variables, model: state.model } }
  }, { prepend: true })
  const retainedNotice: import('@deepseek-ai/cordis').Events['agent/pre-step'] = async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    pendingImages.set(agent, { turn, step, messages: decision.kind === 'enter' ? decision.messages : [] })
    const state = states.get(agent)
    const selected = assembledSelections.get(agent)
    const previous = agent.session.requestHeader()?.config
    if (decision.kind === 'reject' || aborted(signal) || state === undefined || state.turn !== turn
      || selected?.provider !== config.provider || selected.model !== state.requestedModel
      || previous?.provider !== config.provider || previous.model !== state.model || state.model === state.requestedModel) return decision
    const staleSummary = `${state.model} → ${state.requestedModel}`
    return { ...decision, messages: decision.messages.filter(message =>
      message.source.kind !== 'model-selection' || message.source.form !== 'notice' || message.source.summary !== staleSummary) }
  }
  ctx.on('agent/request', async ({ agent, turn, step, signal: agentSignal }, next) => {
    const signal = AbortSignal.any([agentSignal, lifetime.signal])
    const request = await next()
    if (request.provider !== config.provider || aborted(signal)) return request
    if (ctx.llm.listProviders().some(provider => provider.id === 'free-auto')) return request
    await cooldowns.load(signal)
    let models = await listModels()
    if (!models.some(model => model.id === request.model) && !aborted(signal)) {
      // Partial startup catalogs must not retire an explicitly selected model.
      await discover(signal)
      models = await listModels()
    }
    if (aborted(signal)) return request
    let state = states.get(agent)
    if (state === undefined || state.turn !== turn || state.step !== step) {
      // A tool result advances the step, but should not retry a route already rejected this turn.
      const previous = state?.turn === turn && state.requestedModel === request.model ? state.model : undefined
      let model = models.find(candidate => candidate.id === previous)?.id
        ?? models.find(candidate => candidate.id === request.model)?.id ?? models[0]?.id
      if (model === undefined) throw new Error('No anonymous free model is available; refresh model availability in plugin settings')
      const retryNotBefore = cooldowns.times
      const now = Date.now()
      for (const [id, timestamp] of retryNotBefore) if (timestamp <= now) retryNotBefore.delete(id)
      const pending = pendingImages.get(agent)
      const pendingMessages = pending?.turn === turn && pending.step === step ? pending.messages : []
      const history = agent.session.deriveMessages()
      const pendingImageBlocks = pendingMessages.flatMap(message => message.content.filter(block => block.type === 'image'))
      const needsImage = [...history, ...pendingMessages].some(message =>
        message.content.some(block => block.type === 'image' && block.offloaded !== true))
      const imageIncompatible = needsImage
        && !(await ctx.llm.resolveModelInfo(config.provider, model, signal)).inputModalities?.includes('image')
      if (aborted(signal)) return request
      if ((retryNotBefore.get(model) ?? 0) > now || imageIncompatible) {
        // Preserve actual images before core projects them to text placeholders.
        // The same compatibility and cooldown rules apply on first and later steps.
        const tools = assembledSelections.get(agent)?.tools ?? agent.session.requestHeader()?.tools
        const candidates = [...models].sort((left, right) => {
          const rank = (id: string) => {
            const index = config.fallbackPriorityIds.indexOf(id)
            return index < 0 ? config.fallbackPriorityIds.length : index
          }
          return rank(left.id) - rank(right.id)
        })
        let replacement: string | undefined
        for (const candidate of candidates) {
          if ((retryNotBefore.get(candidate.id) ?? 0) > Date.now()
            || state?.turn === turn && state.capabilityRejected.has(candidate.id)) continue
          const info = await ctx.llm.resolveModelInfo(config.provider, candidate.id, signal)
          if (aborted(signal)) return request
          if (needsImage && !info.inputModalities?.includes('image')) continue
          const header = { config: { ...request, model: candidate.id }, ...tools === undefined ? {} : { tools } }
          let pendingTokens = pendingMessages.reduce((total, message) => total + ctx.tokenMeter.estimateMessage(message), 0)
          if (pendingImageBlocks.length > 0) {
            const pricing = ctx.llm.imageRequestPricing(config.provider, candidate.id)
            if (pricing === undefined) continue
            const existing = history.flatMap(message => message.content.filter(block => block.type === 'image'))
            const prices = pricing.priceImages([...existing, ...pendingImageBlocks])
            if (prices.length !== existing.length + pendingImageBlocks.length
              || prices.some(price => !Number.isFinite(price.visualTokens) || price.visualTokens < 0)) continue
            // Keep structural pricing as a conservative extra; never undercount a pending image.
            for (const price of prices.slice(existing.length)) {
              pendingTokens += price.visualTokens + estimateContent([{ type: 'text', text: price.text }])
            }
          }
          const input = ctx.tokenMeter.measure(agent.session, header).totalTokens + pendingTokens
          const output = Math.min(request.maxTokens ?? info.defaultMaxTokens ?? 0, info.defaultMaxTokens ?? request.maxTokens ?? 0)
          if (Math.ceil(input * config.contextSafetyRatio) + output > (info.context?.contextWindow ?? 0)) continue
          replacement = candidate.id
          break
        }
        if (replacement === undefined) {
          const times = [...retryNotBefore].filter(([, timestamp]) => timestamp > Date.now())
            .map(([id, timestamp]) => `${id}: not before ${new Date(timestamp).toISOString()}`).join('; ')
          throw new LlmError(`No available anonymous free route fits this request’s image/context requirements outside known provider cooldowns. Tool declarations and images were preserved. Retry later or select another available model. Keep this conversation and project. ${times}. These times do not guarantee availability; no retry time is inferred for other routes.`, imageIncompatible ? 'FREE_MODEL_NO_COMPATIBLE_ROUTE' : 'FREE_MODEL_UNAVAILABLE')
        }
        model = replacement
      }
      state = { turn, step, model, requestedModel: request.model, tried: new Set([model]),
        capabilityRejected: state?.turn === turn ? state.capabilityRejected : new Set(), switches: 0,
        retryNotBefore }
      states.set(agent, state)
    }
    if (state.model === request.model) return request
    const { reasoningEffort: _effort, ...controls } = request
    const info = await ctx.llm.resolveModelInfo(config.provider, state.model, signal)
    const maxTokens = controls.maxTokens === undefined || info.defaultMaxTokens === undefined
      ? controls.maxTokens : Math.min(controls.maxTokens, info.defaultMaxTokens)
    return { ...controls, model: state.model, ...maxTokens === undefined ? {} : { maxTokens } }
  }, { prepend: true })
  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal: agentSignal }, next) => {
    const signal = AbortSignal.any([agentSignal, lifetime.signal])
    const failedAt = Date.now()
    const recovery = await next()
    const header = agent.session.requestHeader()
    // The catalog exposes no tool-use capability. Recognize only explicit endpoint incompatibility,
    // never arbitrary bad requests or provider advice to remove an individual tool.
    const unsupportedTools = (header?.tools?.length ?? 0) > 0 && failure.code === 'CLIENT_ERROR'
      && (failure.status === 400 || failure.status === 404)
      && new RegExp('no endpoints found that support tool use|'
        + '(?:tool use|tool calling|function calling|tools) (?:is |are )?not supported|'
        + 'does not support (?:tool use|tool calling|function calling|tools)', 'iu').test(failure.message)
    if (recovery !== undefined || aborted(signal) || provider !== config.provider
      || !(unsupportedTools || config.failureCodes.includes(failure.code)
        || config.unavailableMessages.some(message => failure.message.toLowerCase().includes(message)))) return recovery
    const state = states.get(agent)
    if (state === undefined || state.turn !== turn || state.step !== step) return recovery
    for (const [model, timestamp] of state.retryNotBefore) if (timestamp <= failedAt) state.retryNotBefore.delete(model)
    const retryAfter = failure.providerRetryAfterMs
    if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0
      && Number.isFinite(failedAt + retryAfter) && failedAt + retryAfter <= 8640000000000000) {
      await cooldowns.remember(state.model, failedAt + retryAfter, signal)
      if (aborted(signal)) return recovery
    }
    if (unsupportedTools) state.capabilityRejected.add(state.model)
    const exhausted = (code: string, summary: string): never => {
      const known = [...state.retryNotBefore].filter(([, timestamp]) => timestamp > Date.now())
        .sort((left, right) => left[1] - right[1])
      const retryHint = known.length === 0 ? ' No future retry time was supplied for the remaining failures.'
        : ` Some routes supplied retry times (UTC): ${known.map(([model, timestamp]) => `${model}: not before ${new Date(timestamp).toISOString()}`).join('; ')}. These times do not guarantee availability; no retry time is inferred for other routes.`
      throw new LlmError(`${summary} Tool declarations and images were preserved. Retry later or select another available model. Keep this conversation and project; when ready, send a continuation message here and inspect existing project files before resuming interrupted work.${retryHint} Last error from ${state.model} (${failure.code}): ${failure.message}`, code, {
        ...failure.status === undefined ? {} : { status: failure.status },
        ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
      })
    }
    const models = await listModels()
    if (header === undefined) return recovery
    const needsImage = agent.session.deriveMessages().some(message =>
      message.content.some(block => block.type === 'image' && block.offloaded !== true))
    const prioritized = [...models].sort((left, right) => {
      const rank = (id: string) => {
        const index = config.fallbackPriorityIds.indexOf(id)
        return index < 0 ? config.fallbackPriorityIds.length : index
      }
      return rank(left.id) - rank(right.id)
    })
    const current = await ctx.llm.resolveModelInfo(provider, state.model, signal)
    const preferImages = current.inputModalities?.includes('image') === true
    const resolved = await Promise.all(prioritized.map(async candidate => ({
      candidate, info: await ctx.llm.resolveModelInfo(provider, candidate.id, signal),
    })))
    if (preferImages) resolved.sort((left, right) => Number(right.info.inputModalities?.includes('image') === true)
      - Number(left.info.inputModalities?.includes('image') === true))
    let compatible = 0
    for (const { candidate, info } of resolved) {
      if (needsImage && !info.inputModalities?.includes('image')) continue
      const candidateHeader = { ...header, config: { ...header.config, provider, model: candidate.id } }
      const inputTokens = ctx.tokenMeter.measure(agent.session, candidateHeader).totalTokens
      const outputTokens = Math.min(
        header.config.maxTokens ?? info.defaultMaxTokens ?? 0, info.defaultMaxTokens ?? header.config.maxTokens ?? 0)
      if (Math.ceil(inputTokens * config.contextSafetyRatio) + outputTokens > (info.context?.contextWindow ?? 0)) continue
      compatible += 1
      if (state.tried.has(candidate.id) || state.capabilityRejected.has(candidate.id)
        || (state.retryNotBefore.get(candidate.id) ?? 0) > Date.now()) continue
      if (aborted(signal)) return recovery
      if (state.switches >= config.maxSwitches) return exhausted('FREE_MODEL_RETRY_LIMIT', `Free-model switching stopped at the configured limit (${config.maxSwitches}); untried compatible routes remain.`)
      state.model = candidate.id
      state.tried.add(candidate.id)
      state.switches += 1
      return { kind: 'retry' }
    }
    if (aborted(signal)) return recovery
    return compatible === 0
      ? exhausted('FREE_MODEL_NO_COMPATIBLE_ROUTE', 'No currently advertised anonymous free model fits this request’s image and context requirements.')
      : exhausted('FREE_MODEL_UNAVAILABLE', 'The compatible anonymous free routes have all failed, remain in a known provider cooldown, or already rejected the required tools in this turn.')
  }, { prepend: true })
}
