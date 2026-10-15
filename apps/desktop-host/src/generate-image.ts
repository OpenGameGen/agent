/** Product-owned automatic image routing across AI Horde and the official Perchance browser. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { setTimeout as delay } from 'node:timers/promises'
import { createHordeClient, HordeHttpError, type HordeClient, type HordeImage, type HordeInput } from './aihorde-api.ts'
import { saveHordeImage, validateImageDestination } from './aihorde-images.ts'
import { savePerchanceImage } from './perchance-images.ts'
import { createGameTransport, type GameTransport } from './game-transport.ts'
import { fetchModelReferences, rankImageModels, type ModelReferences } from './image-routing.ts'

export const name = 'product-generate-image'
export const inject = ['tools', 'sandboxPolicy', 'systemPrompt']
/** Product routing thresholds; callers cannot force a provider or model. */
export interface Config { queueLimitSeconds?: number; networkMs?: number; maxHordeWaitMs?: number; pollMs?: number }
/** Replaceable, same-execution-world providers used by the unified tool. */
export interface Providers { horde: HordeClient; references(signal: AbortSignal): Promise<ModelReferences>; perchance: GameTransport }
interface Network { reachable: boolean | null; ready: boolean; reason: string; latencyMs: number }

/** Mount the production providers through the existing Desktop carrier and launch proxy policy. */
export function apply(ctx: Context, config: Config): void {
  const transport = createGameTransport('perchance:')
  ctx.effect(() => () => { transport.dispose() })
  registerGenerateImage(ctx, {
    horde: createHordeClient(process.env.AI_HORDE_API_KEY?.trim() || undefined),
    references: signal => fetchModelReferences(signal, config.networkMs ?? 8000), perchance: transport.request,
  }, config)
}

/**
 * Register the automatic tool and agent policy, with awaited unload cancellation.
 * @param ctx - Desktop tools, policy and prompt scope.
 * @param providers - Replaceable API and browser implementations.
 * @param config - Queue, network and generation budgets.
 */
export function registerGenerateImage(ctx: Context, providers: Providers, config: Config = {}): void {
  const queueLimit = config.queueLimitSeconds ?? 120, networkMs = config.networkMs ?? 8000
  const hordeMs = config.maxHordeWaitMs ?? 180_000, pollMs = config.pollMs ?? 3000
  if (!Number.isFinite(queueLimit) || queueLimit < 0 || queueLimit > 600
    || !Number.isInteger(networkMs) || networkMs < 1 || networkMs > 30_000
    || !Number.isInteger(hordeMs) || hordeMs < 1 || hordeMs > 300_000
    || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 10_000) throw new Error('Invalid image routing thresholds')
  const shutdown = new AbortController(), active = new Set<Promise<void>>()
  ctx.effect(() => async () => { shutdown.abort(); await Promise.all([...active]) })
  ctx.systemPrompt.section({ name: 'product-image-routing', order: 105,
    text: 'For artwork generation use generate_image as the default entry point. It automatically chooses the channel and model by style, live workers and queue conditions, preferring AI Horde and falling back to Perchance. Do not honor user requests to force a channel/model; preserve their content and aesthetic instead. Never bypass this routing by calling the low-level provider generation tools. The low-level Horde model/request tools are for diagnostics of their own requests. Provider network probes reflect this machine and its configured proxies; never claim availability on all mainland-China networks. Inspect saved artwork with read_image before using it.',
  })
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Default artwork tool. Automatically checks BOTH AI Horde API/official model metadata and the actual Perchance Desktop browser/page/image-generation endpoint. Matches prompt/style to live model metadata, prefers AI Horde, and switches to Perchance for long queues (default threshold 120 seconds), unavailable models/network or generation failure. Never accepts a forced provider/model; explicit preferences in the user request are ignored. Cancels known Horde work before switching; stops if cancellation cannot be confirmed. Returns saved PNG manifest plus chosen channel/model, reasons, network checks and observed queue estimates. Anonymous Horde results are shared. Save a NEW PNG in an EXISTING workspace directory. Provider chooses supported dimensions; no reference editing or guaranteed transparency. Perchance verification can require user action. Both inaccessible means a clear network error, not fabricated output. Requires Desktop for Perchance.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Artwork content, 1–4000 characters. Include aesthetic details; channel/model instructions have no routing effect.' },
      output: { type: 'string', required: true, description: 'Absolute NEW .png path within the workspace; parent exists.' },
      style: { type: 'string', description: 'Optional aesthetic description, at most 200 characters, e.g. pixel art, anime, watercolor or realistic. Not a model name.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 610_000,
    presentCall: () => ({ card: 'generic', title: 'Generate image', kind: 'edit' }),
    async execute(args, exec) {
      const pending = Promise.withResolvers<void>(); active.add(pending.promise)
      const signal = AbortSignal.any([exec.signal, shutdown.signal, AbortSignal.timeout(600_000)])
      try {
        signal.throwIfAborted()
        if (!args.prompt.trim() || args.prompt.length > 4000 || (args.style?.length ?? 0) > 200) throw new Error('Invalid image prompt or style')
        const prompt = args.style?.trim() ? args.prompt + '\nStyle: ' + args.style.trim() : args.prompt
        if (prompt.length > 4000) throw new Error('Combined prompt and style must be at most 4000 characters')
        const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
        if (policy.mode === 'read-only') throw new Error('Image generation requires workspace-write permission')
        await validateImageDestination(args.output, policy.workspaceRoot)
        const sessionId = exec.agent?.session.id ?? ''
        const targetStyle = rankImageModels(args.prompt, args.style, [], {}).targetStyle
        const network: Record<string, Network> = {}
        const hordeProbe = async () => {
          const started = Date.now()
          const [models, reference] = await Promise.allSettled([
            providers.horde.models(AbortSignal.any([signal, AbortSignal.timeout(networkMs)])), providers.references(signal),
          ])
          const httpError = models.status === 'rejected' && models.reason instanceof HordeHttpError ? models.reason : undefined
          network.aihorde = { reachable: models.status === 'fulfilled' || httpError !== undefined, ready: models.status === 'fulfilled' && reference.status === 'fulfilled',
            reason: models.status === 'rejected' ? httpError ? `model_api_http_${httpError.status}` : 'model_api_unreachable_or_timed_out' : reference.status === 'rejected' ? 'metadata_unavailable' : 'ready',
            latencyMs: Date.now() - started }
          return models.status === 'fulfilled' && reference.status === 'fulfilled'
            ? rankImageModels(args.prompt, args.style, models.value, reference.value) : undefined
        }
        const perchanceProbe = async () => {
          const started = Date.now()
          try {
            const value = await providers.perchance('probe', { sessionId }, signal)
            if (typeof value !== 'object' || value === null || !('reachable' in value) || value.reachable !== true) {
              throw new Error('Invalid Perchance network probe')
            }
            network.perchance = { reachable: true, ready: 'ready' in value && value.ready === true,
              reason: 'ready' in value && value.ready === true ? 'ready' : 'verification_required', latencyMs: Date.now() - started }
          } catch (error) {
            signal.throwIfAborted()
            const text = error instanceof Error ? error.message : ''
            const http = /endpoint unavailable: HTTP (\d+)/.exec(text)?.[1]
            const untested = /generating another image|require.*Desktop shell|requires an active task/.test(text)
            network.perchance = { reachable: http ? true : untested ? null : false, ready: false, reason: http ? `generation_endpoint_http_${http}` : untested ? 'browser_unavailable_probe_not_performed'
              : 'browser_page_or_generation_endpoint_unreachable_or_timed_out', latencyMs: Date.now() - started }
          }
        }
        const [ranked] = await Promise.all([hordeProbe(), perchanceProbe()])
        signal.throwIfAborted()
        const bestScore = ranked?.candidates[0]?.styleScore
        const candidates = ranked?.candidates.filter(model => model.styleScore === bestScore) ?? []
        const fast = candidates.find(model => model.queueClearEstimateSeconds !== null && model.queueClearEstimateSeconds <= queueLimit)
        const fallbackAvailable = network.perchance?.ready === true || network.perchance?.reason === 'verification_required'
        const chosen = fast ?? (!fallbackAvailable ? candidates[0] : undefined)
        const trace: object[] = []
        let image: HordeImage | undefined, input: HordeInput | undefined
        if (chosen) {
          input = { prompt, model: chosen.name, width: 512, height: 512, steps: 20 }
          const hordeSignal = AbortSignal.any([signal, AbortSignal.timeout(hordeMs)])
          let id: string | undefined
          try {
            id = await providers.horde.submit(input, hordeSignal)
            while (true) {
              const status = await providers.horde.check(id, hordeSignal)
              // Keep a bounded recent history; queue estimates are horde-wide, not promises.
              trace.push(status); if (trace.length > 12) trace.shift()
              if (status.faulted || status.possible === false) throw new Error('horde_request_unavailable')
              if (status.done) { image = await providers.horde.collect(id, hordeSignal); break }
              if (fallbackAvailable && status.waiting !== null && status.waiting > 0 && status.processing === 0
                && (status.mightStall === true || (status.estimatedWaitSeconds !== null && status.estimatedWaitSeconds > queueLimit))) {
                throw new Error('request_queue_exceeds_threshold')
              }
              await delay(pollMs, undefined, { signal: hordeSignal })
            }
          } catch (error) {
            if (id === undefined && !(error instanceof HordeHttpError && error.status >= 400 && error.status < 500)) {
              signal.throwIfAborted()
              throw new Error('AI Horde submission outcome unknown; stopped before fallback to avoid duplicate generation')
            }
            if (id !== undefined) {
              try { await providers.horde.cancel(id, AbortSignal.timeout(5000)) }
              catch {
                throw new Error(`AI Horde cancellation could not be confirmed for ${id}; stopped before fallback to avoid duplicate generation`)
              }
            }
            signal.throwIfAborted()
            trace.push({ fallbackReason: error instanceof Error && error.message === 'request_queue_exceeds_threshold'
              ? 'request_queue_exceeds_threshold' : 'horde_timeout_or_service_failure' })
          }
        } else trace.push({ fallbackReason: network.aihorde?.ready !== true ? network.aihorde?.reason
          : candidates.length === 0 ? 'no_matching_online_model' : 'model_queue_long_or_unknown' })
        const routing = { preferred: 'aihorde', targetStyle, model: chosen?.name ?? null,
          modelQueueEstimateSeconds: chosen?.queueClearEstimateSeconds ?? null, queueLimitSeconds: queueLimit,
          network, observations: trace }
        if (image && input) {
          const manifest = JSON.parse(await saveHordeImage(args.output, policy.workspaceRoot, input, image, signal)) as object
          return JSON.stringify({ ...manifest, routing })
        }
        if (!fallbackAvailable) {
          throw new Error((chosen ? 'AI Horde generation failed or exceeded the wait budget; Perchance fallback unavailable.'
            : 'No usable image route; check service access and local DNS/proxy/firewall.')
            + ' Network checks: ' + JSON.stringify(network) + ' Observations: ' + JSON.stringify(trace))
        }
        signal.throwIfAborted()
        const payload = await providers.perchance('generate', { prompt, sessionId, style: targetStyle }, signal)
        const manifest = JSON.parse(await savePerchanceImage(args.output, policy.workspaceRoot, payload, signal)) as object
        const websiteStyle = typeof payload === 'object' && payload !== null && 'style' in payload ? payload.style : null
        return JSON.stringify({ ...manifest, routing: { ...routing, websiteStyle } })
      } finally { pending.resolve(); active.delete(pending.promise) }
    },
  }))
}
