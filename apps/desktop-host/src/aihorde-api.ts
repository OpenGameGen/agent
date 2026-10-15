/** Official AI Horde asynchronous image API; inline results avoid arbitrary URL downloads. */
import { setTimeout as delay } from 'node:timers/promises'

/** Text-to-image options sent to community workers. */
export interface HordeInput {
  prompt: string
  model?: string
  width: number
  height: number
  steps: number
}
/** Completed uncensored generation, with request identity from the official API. */
export interface HordeImage { data: Buffer; requestId: string; model: string; seed: string; shared: boolean }

/** Service responded over HTTP but did not accept the operation. */
export class HordeHttpError extends Error {
  /** HTTP code is public diagnostic information; response bodies and keys stay private. */
  constructor(readonly status: number) {
    super(`AI Horde HTTP ${status}; check service availability, key, kudos or request parameters`)
  }
}

/**
 * Official HTTP client with bounded responses and caller cancellation.
 * @param signal - Default request cancellation.
 * @param apiKey - Local credential; anonymous by default.
 * @param request - Replaceable HTTP transport.
 * @returns JSON transport used by model and generation operations.
 */
function transport(signal: AbortSignal, apiKey: string, request: typeof fetch) {
  const headers = { apikey: apiKey, 'Content-Type': 'application/json', 'Client-Agent': 'OpenGameDesktop:1.0:https://github.com/OpenGameGen/agent' }
  const api = async (path: string, method = 'GET', body?: object, activeSignal: AbortSignal = signal): Promise<unknown> => {
    const response = await request('https://aihorde.net/api/v2/' + path, { method, headers, signal: AbortSignal.any([activeSignal, AbortSignal.timeout(30_000)]),
      redirect: 'error', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    // Avoid logging credentials or reflecting untrusted error bodies into tool history.
    if (!response.ok) throw new HordeHttpError(response.status)
    if (response.body === null) throw new Error('Empty AI Horde response')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 24 * 1024 * 1024) throw new Error('AI Horde response exceeds image size limit')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    const value: unknown = JSON.parse(text)
    return value
  }
  return api
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid AI Horde response')
  return value as Record<string, unknown>
}

/** Validate a service request ID before using it in an endpoint path. */
function requestId(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid AI Horde request ID')
  return id
}

/** Agent-visible live image model, with service estimates kept separate from request estimates. */
export interface HordeModel {
  name: string
  workers: number
  queuedJobs: number | null
  queueClearEstimateSeconds: number | null
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Create a replaceable official API provider for interactive image requests.
 * @param apiKey - Local credential; never included in returned information.
 * @param request - HTTP transport; production uses the launcher's global dispatcher.
 * @returns Submit, check, collect, cancel and model discovery operations.
 */
export function createHordeClient(apiKey = '0000000000', request: typeof fetch = fetch) {
  const call = async (path: string, signal: AbortSignal, method = 'GET', body?: object) =>
    transport(signal, apiKey, request)(path, method, body)
  return {
    async models(signal: AbortSignal): Promise<HordeModel[]> {
      const data = await call('status/models?type=image', signal)
      if (!Array.isArray(data)) throw new Error('Invalid AI Horde model list')
      return data.map((entry: unknown) => {
        const model = object(entry)
        if (typeof model.name !== 'string' || model.name.length > 200 || count(model.count) === null) {
          throw new Error('Invalid AI Horde model entry')
        }
        return { name: model.name, workers: model.count as number, queuedJobs: count(model.jobs),
          queueClearEstimateSeconds: count(model.eta) }
      })
    },
    async submit(input: HordeInput, signal: AbortSignal): Promise<string> {
      const data = object(await call('generate/async', signal, 'POST', {
        prompt: input.prompt, params: { width: input.width, height: input.height, steps: input.steps, n: 1, sampler_name: 'k_euler', cfg_scale: 7.5 },
        ...(input.model === undefined ? {} : { models: [input.model] }),
        r2: false, nsfw: false, censor_nsfw: true, shared: false, trusted_workers: true,
      }))
      if (typeof data.id !== 'string') throw new Error('AI Horde did not return a request ID')
      return requestId(data.id)
    },
    async check(id: string, signal: AbortSignal) {
      const data = object(await call('generate/check/' + requestId(id), signal))
      if (typeof data.done !== 'boolean') throw new Error('Invalid AI Horde request status')
      return { requestId: id, done: data.done, faulted: data.faulted === true,
        waiting: count(data.waiting), processing: count(data.processing), finished: count(data.finished), restarted: count(data.restarted),
        estimatedWaitSeconds: count(data.wait_time), queuePosition: count(data.queue_position),
        possible: typeof data.is_possible === 'boolean' ? data.is_possible : null,
        eligibleWorkers: count(data.eligible_workers), eligibleWorkerThreads: count(data.eligible_worker_threads),
        mightStall: typeof data.might_stall === 'boolean' ? data.might_stall : null }
    },
    async collect(id: string, signal: AbortSignal): Promise<HordeImage> {
      const result = object(await call('generate/status/' + requestId(id), signal))
      if (result.done !== true || result.faulted === true || !Array.isArray(result.generations)) {
        throw new Error('AI Horde request has no completed generation; check status first')
      }
      const image = object(result.generations[0])
      if (typeof image.img !== 'string' || image.censored === true) throw new Error('AI Horde returned no uncensored image')
      if (image.img.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.img)) {
        throw new Error('AI Horde returned invalid inline image data')
      }
      const data = Buffer.from(image.img, 'base64')
      if (data.toString('base64') !== image.img || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('AI Horde returned no WebP image')
      }
      return { data, requestId: id, model: typeof image.model === 'string' ? image.model : 'unknown',
        seed: typeof image.seed === 'string' ? image.seed : '', shared: apiKey === '0000000000' || result.shared === true }
    },
    async cancel(id: string, signal: AbortSignal): Promise<void> {
      await call('generate/status/' + requestId(id), signal, 'DELETE')
    },
  }
}

/** Replaceable provider used by the Cordis tools. */
export type HordeClient = ReturnType<typeof createHordeClient>

/**
 * Submit one generation and retrieve inline WebP bytes; aborts attempt remote cancellation.
 * @param input - Validated image parameters.
 * @param signal - Caller cancellation and total deadline.
 * @param apiKey - Local credential; the default is the official anonymous key.
 * @param request - Replaceable HTTP transport for tests.
 * @param pollMs - Check interval, at least one second in production.
 * @returns Image bytes and actual worker model/seed.
 */
export async function generateHordeImage(input: HordeInput, signal: AbortSignal, apiKey = '0000000000', request: typeof fetch = fetch, pollMs = 3000): Promise<HordeImage> {
  const client = createHordeClient(apiKey, request)
  signal.throwIfAborted()
  const id = await client.submit(input, signal)
  let completed = false
  try {
    while (true) {
      signal.throwIfAborted()
      const check = await client.check(id, signal)
      if (check.faulted) throw new Error('AI Horde generation faulted')
      if (check.possible === false) throw new Error('No AI Horde worker can serve these parameters; choose another model or smaller dimensions')
      if (check.done) break
      await delay(pollMs, undefined, { signal })
    }
    const image = await client.collect(id, signal)
    completed = true
    return image
  } finally {
    if (!completed) await client.cancel(id, AbortSignal.timeout(5000)).catch(() => undefined)
  }
}
