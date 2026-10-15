/** Authenticated, in-memory network checks using the loaded model adapter and Desktop network. */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createHordeClient, HordeHttpError } from './aihorde-api.ts'
import { createGameTransport } from './game-transport.ts'
import type { Config as FreeConfig } from './free-models.ts'
import { networkDiagnosticsPage } from './network-diagnostics-page.ts'
import { AUTO_MODEL, AUTO_PROVIDER } from './free-auto.ts'

export const name = 'product-network-diagnostics'
export const inject = ['llm', 'webServer', 'connection']

/** Deployment-owned bounded check budgets. */
export interface Config {
  free: FreeConfig
  requestMs: number
  discoveryMs: number
}

/** One current result; no provider response text or credentials are retained. */
export interface DiagnosticRow {
  id: string
  name: string
  status: 'idle' | 'running' | 'success' | 'error' | 'cancelled'
  detail: string
  elapsedMs?: number
  checkedAt?: string
}

/** Provider calls isolated for fixtures; production resolves them from public services. */
export interface DiagnosticProviders {
  models(this: void): Promise<readonly { id: string; name: string }[]>
  discover(this: void, signal: AbortSignal): Promise<void>
  stream(this: void, model: string, signal: AbortSignal): AsyncIterable<StreamChunk>
  horde(this: void, signal: AbortSignal): Promise<string>
  perchance(this: void, signal: AbortSignal): Promise<string>
}

/** Safe error taxonomy, without raw adapter messages that may contain private URLs. */
export function diagnosticFailure(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED'
  if (error instanceof HordeHttpError) return `HTTP_${error.status}`
  if (error instanceof LlmError) return /^[A-Z][A-Z_0-9]{0,63}$/u.test(error.code) ? error.code : 'PROVIDER_ERROR'
  return 'NETWORK_OR_SERVICE_ERROR'
}

/** One global operator run; overlapping checks cannot consume duplicate free requests. */
export class NetworkDiagnostics {
  private readonly rows = new Map<string, DiagnosticRow>([
    ['models', { id: 'models', name: 'Free model channel', status: 'idle', detail: '' }],
    ['images', { id: 'images', name: 'Free image channel', status: 'idle', detail: '' }],
  ])
  private active: { controller: AbortController; done: Promise<void> } | undefined

  /** @param providers - Loaded routes. @param config - Finite request deadlines. */
  constructor(private readonly providers: DiagnosticProviders, private readonly config: Config) {}

  /** @returns Detached results suitable for the local operator UI. */
  snapshot(): { running: boolean; rows: DiagnosticRow[] } {
    return { running: this.active !== undefined, rows: [...this.rows.values()].map(row => ({ ...row })) }
  }

  private async representative(signal: AbortSignal): Promise<string> {
    const pattern = new RegExp(this.config.free.anonymousModelPattern, 'u')
    const available = async () => (await this.providers.models()).filter(model => pattern.test(model.id)
      || this.config.free.anonymousModelIds.includes(model.id)
      || this.config.free.anonymousModelNamePrefixes.some(prefix => model.name.startsWith(prefix)))
    let models = await available()
    if (models.length === 0) {
      await this.providers.discover(AbortSignal.any([signal, AbortSignal.timeout(this.config.discoveryMs)]))
      models = await available()
    }
    const chosen = this.config.free.fallbackPriorityIds.map(id => models.find(model => model.id === id))
      .find(model => model !== undefined) ?? models[0]
    if (!chosen) throw new LlmError('No free model advertised', 'NO_FREE_MODELS')
    return this.model(chosen.id, signal)
  }

  private async images(signal: AbortSignal): Promise<string> {
    const results = await Promise.allSettled([this.providers.horde(signal), this.providers.perchance(signal)])
    signal.throwIfAborted()
    const horde = results[0].status === 'fulfilled', perchance = results[1].status === 'fulfilled'
    if (horde && perchance) return 'BOTH_IMAGES_AVAILABLE'
    if (horde) return 'HORDE_AVAILABLE'
    if (perchance) return 'PERCHANCE_AVAILABLE'
    throw new LlmError('Both image channels unavailable', 'IMAGE_CHANNELS_UNAVAILABLE')
  }

  private async check(id: string, operation: (signal: AbortSignal) => Promise<string>, parent: AbortSignal, budget: number): Promise<void> {
    const row = this.rows.get(id)
    if (!row || parent.aborted) return
    const signal = AbortSignal.any([parent, AbortSignal.timeout(budget)])
    const started = Date.now()
    row.status = 'running'; row.detail = ''
    try {
      row.detail = await operation(signal)
      signal.throwIfAborted()
      row.status = 'success'
    } catch (error) {
      row.detail = diagnosticFailure(error, signal)
      row.status = row.detail === 'CANCELLED' ? 'cancelled' : 'error'
    } finally {
      row.elapsedMs = Date.now() - started; row.checkedAt = new Date().toISOString()
    }
  }

  private async model(model: string, signal: AbortSignal): Promise<string> {
    let text = false, completed = false
    for await (const chunk of this.providers.stream(model, signal)) {
      signal.throwIfAborted()
      if (chunk.type === 'text-delta' && chunk.text.trim()) text = true
      if (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.trim()) text = true
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          throw new LlmError('Diagnostic request failed', chunk.reason.failure.code)
        }
        completed = chunk.reason.kind === 'stop' || chunk.reason.kind === 'max-tokens'
      }
    }
    if (!completed || !text) throw new LlmError('Diagnostic request returned no completed text', 'EMPTY_RESPONSE')
    return 'MODEL_COMPLETED'
  }

  /** Start all checks or one current row; results continue through page refresh. @param target - Current row id. */
  start(target?: string): void {
    if (this.active) throw new Error('BUSY')
    if (target !== undefined && !this.rows.has(target)) throw new Error('UNKNOWN_TARGET')
    const controller = new AbortController()
    const run = async () => {
      const signal = controller.signal
      await Promise.all([
        ...target === undefined || target === 'models'
          ? [this.check('models', inner => this.representative(inner), signal, this.config.requestMs)] : [],
        ...target === undefined || target === 'images'
          ? [this.check('images', inner => this.images(inner), signal, this.config.requestMs)] : [],
      ])
    }
    const done = Promise.resolve().then(run).finally(() => { this.active = undefined })
    this.active = { controller, done }
  }

  /** Abort and await outstanding calls before disposal or another run. */
  async cancel(): Promise<void> { this.active?.controller.abort(); await this.active?.done }
}

/** Mount the authenticated page and bounded diagnostics using public Host services. */
export function apply(ctx: Context, config: Config): void {
  for (const value of [config.requestMs, config.discoveryMs]) {
    if (!Number.isInteger(value) || value < 1000 || value > 120000) throw new Error('Invalid diagnostics deadline')
  }
  const transport = createGameTransport('perchance:')
  const horde = createHordeClient(process.env.AI_HORDE_API_KEY)
  const diagnostics = new NetworkDiagnostics({
    models: () => ctx.llm.listModels(config.free.provider),
    discover: signal => ctx.llm.discoverModels(config.free.settingsNamespace,
      { provider: config.free.provider }, signal).then(() => undefined),
    stream: (model, signal) => {
      const automatic = ctx.llm.listProviders().some(provider => provider.id === AUTO_PROVIDER)
      return ctx.llm.stream({ provider: automatic ? AUTO_PROVIDER : config.free.provider,
        model: automatic ? AUTO_MODEL : model, signal, maxTokens: 64,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }] })
    },
    horde: async (signal) => {
      const models = await horde.models(signal)
      if (!models.some(model => model.workers > 0)) throw new LlmError('No image workers online', 'NO_IMAGE_WORKERS')
      return 'IMAGE_MODELS_AVAILABLE'
    },
    perchance: async (signal) => {
      const result = await transport.request('network', {}, signal)
      if (typeof result !== 'object' || result === null || !('ok' in result)) throw new Error('Invalid network response')
      if (result.ok !== true) {
        const code = 'code' in result && typeof result.code === 'string' && /^HTTP_\d{3}$|^TIMEOUT$|^NETWORK_OR_SERVICE_ERROR$/u.test(result.code)
          ? result.code : 'NETWORK_OR_SERVICE_ERROR'
        throw new LlmError('Perchance endpoint check failed', code)
      }
      return 'IMAGE_ENDPOINTS_REACHABLE'
    },
  }, config)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/product/network', handler: (req, res) => {
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    const nonce = randomBytes(16).toString('base64')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'` })
    res.end(networkDiagnosticsPage(nonce, new URL(req.url ?? '/', 'http://localhost').searchParams.get('lang') === 'zh'))
  } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/product/network/state', handler: async (req, res) => {
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405); res.end(); return }
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (req.method === 'POST') {
        if (req.headers['x-product-diagnostics'] !== '1') { res.writeHead(403); res.end(); return }
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        if (params.get('action') === 'cancel') await diagnostics.cancel()
        else if (params.get('action') === 'start') diagnostics.start(params.get('target') ?? undefined)
        else { res.writeHead(400); res.end(); return }
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(diagnostics.snapshot()))
    } catch (error) {
      res.writeHead(error instanceof Error && error.message === 'BUSY' ? 409 : 503); res.end()
    }
  } }))
  ctx.effect(() => async () => { await diagnostics.cancel(); transport.dispose() })
}
