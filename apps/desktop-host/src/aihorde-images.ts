/** Independent Cordis tool for AI Horde text-to-image generation. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { lstat, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import sharp from 'sharp'
import { createHordeClient, generateHordeImage, type HordeClient, type HordeImage, type HordeInput } from './aihorde-api.ts'

/** Stable Cordis loader identity. */
export const name = 'product-aihorde-images'
/** Services required before tool registration. */
export const inject = ['tools', 'sandboxPolicy']

/**
 * Validate a new PNG destination before external work or an exclusive write.
 * @param output - Absolute requested destination.
 * @param workspace - Standing workspace root.
 * @returns Canonical contained path; refuses existing files and escaping symlinks.
 */
export async function validateImageDestination(output: string, workspace: string): Promise<string> {
  if (!isAbsolute(output) || !output.toLowerCase().endsWith('.png')) throw new Error('output must be an absolute NEW .png path')
  const root = await realpath(workspace), parent = await realpath(dirname(output))
  const delta = relative(root, parent)
  if (delta === '..' || delta.startsWith('..' + sep) || isAbsolute(delta)) throw new Error('Image output must be inside the workspace')
  const path = join(parent, basename(output))
  try { await lstat(path); throw new Error('Image output already exists; choose a new filename') }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  return path
}

/**
 * Mount the official API provider with credentials from local Host environment.
 * @param ctx - Desktop plugin scope.
 */
export function apply(ctx: Context): void {
  registerHordeImages(ctx, (input, signal) => generateHordeImage(input, signal, process.env.AI_HORDE_API_KEY?.trim() || undefined))
}

/**
 * Register the image tool on the public, disposable tools service.
 * @param ctx - Desktop profile scope with tools and sandboxPolicy.
 * @param generate - Replaceable generation provider receiving the bounded caller signal.
 * @param client - Interactive request provider; production uses the official API.
 */
export function registerHordeImages(ctx: Context, generate: (input: HordeInput, signal: AbortSignal) => Promise<HordeImage>,
  client: HordeClient = createHordeClient(process.env.AI_HORDE_API_KEY?.trim() || undefined)): void {
  const lifecycle = registerInteractiveHorde(ctx, client)
  ctx.tools.register(defineTool({
    name: 'aihorde_generate_image',
    description: 'Generate one raster artwork through the official AI Horde community API and save a NEW PNG inside an EXISTING workspace directory. Sends your prompt to community workers. Anonymous by default: low queue priority, high-load restrictions, and anonymous images are shared by the service. Optional local AI_HORDE_API_KEY improves account priority; never pass keys in tool arguments. Supports prompt, model, width, height and steps. Call aihorde_list_models before choosing a model. For observable progress prefer aihorde_image_request submit/status/save instead. May take minutes; cancellation/timeout attempts to cancel queued work. Returns actual dimensions, worker model, seed, sharing flag and SHA-256. Inspect with read_image before using in a game. No reference-image editing or guaranteed transparency.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image description, 1–4000 characters; optionally append ### negative prompt.' },
      output: { type: 'string', required: true, description: 'Absolute NEW .png path in the workspace; parent directory must exist.' },
      model: { type: 'string', description: 'Optional exact AI Horde model name; omitted uses the service default stable_diffusion.' },
      width: { type: 'integer', description: '256–1024, multiple of 64; default 512.' },
      height: { type: 'integer', description: '256–1024, multiple of 64; default 512.' },
      steps: { type: 'integer', description: '1–50; default 20. Larger requests may require kudos.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 605_000,
    presentCall: () => ({ card: 'generic', title: 'AI Horde image generation', kind: 'edit' }),
    execute(args, exec) {
      return lifecycle.run(async () => {
        const input = imageInput(args)
        const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
        if (policy.mode === 'read-only') throw new Error('Image generation requires workspace-write permission')
        await validateImageDestination(args.output, policy.workspaceRoot)
        const signal = AbortSignal.any([exec.signal, lifecycle.shutdown, AbortSignal.timeout(600_000)])
        signal.throwIfAborted()
        const image = await generate(input, signal)
        signal.throwIfAborted()
        return saveHordeImage(args.output, policy.workspaceRoot, input, image, signal)
      })
    },
  }))
}

function imageInput(args: { prompt?: string; width?: number; height?: number; steps?: number; model?: string }): HordeInput {
  if (args.prompt === undefined || !args.prompt.trim() || args.prompt.length > 4000) throw new Error('Prompt must contain 1–4000 characters')
  const width = args.width ?? 512, height = args.height ?? 512, steps = args.steps ?? 20
  if ([width, height].some(value => value < 256 || value > 1024 || value % 64 !== 0)) {
    throw new Error('Dimensions must be multiples of 64 between 256 and 1024')
  }
  if (steps < 1 || steps > 50) throw new Error('steps must be between 1 and 50')
  if (args.model !== undefined && (!args.model.trim() || args.model.length > 200)) throw new Error('Invalid model name')
  return { prompt: args.prompt, width, height, steps, ...(args.model === undefined ? {} : { model: args.model }) }
}

/**
 * Decode and exclusively save a completed Horde raster.
 * @param output - New PNG path.
 * @param workspace - Standing workspace root.
 * @param input - Submitted dimensions.
 * @param image - Completed provider bytes and request metadata.
 * @param signal - Cancellation before persistence.
 * @returns JSON image manifest.
 */
export async function saveHordeImage(output: string, workspace: string, input: HordeInput,
  image: HordeImage, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const { data, info } = await sharp(image.data, { failOn: 'error', limitInputPixels: 1048576 }).png().toBuffer({ resolveWithObject: true })
  if (info.width !== input.width || info.height !== input.height) throw new Error('AI Horde image dimensions do not match the request')
  const path = await validateImageDestination(output, workspace)
  signal.throwIfAborted()
  await writeFile(path, data, { flag: 'wx', mode: 0o600 })
  return JSON.stringify({ provider: 'aihorde', path, width: info.width, height: info.height, bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), requestId: image.requestId, model: image.model, seed: image.seed, shared: image.shared })
}

function registerInteractiveHorde(ctx: Context, client: HordeClient) {
  type Request = { owner: string; workspace: string; input: HordeInput; output: string; busy: boolean }
  const requests = new Map<string, Request>()
  let disposed = false, submitting = 0
  const isDisposed = () => disposed
  const shutdown = new AbortController()
  const active = new Set<Promise<void>>()
  async function run<T>(work: () => Promise<T>): Promise<T> {
    if (isDisposed()) throw new Error('AI Horde plugin is unloading')
    const pending = Promise.withResolvers<void>()
    active.add(pending.promise)
    try { return await work() }
    finally { pending.resolve(); active.delete(pending.promise) }
  }
  ctx.effect(() => async () => {
    disposed = true
    shutdown.abort()
    await Promise.all([...active])
    await Promise.all([...requests.keys()].map(id => client.cancel(id, AbortSignal.timeout(5000)).catch(() => undefined)))
    requests.clear()
  })
  ctx.tools.register(defineTool({
    name: 'aihorde_list_models',
    description: 'Query current AI Horde image models before generating. Returns exact model names, online worker counts, queued job counts and queueClearEstimateSeconds. That estimate is for clearing the MODEL queue, not your personal wait; null means unavailable, zero is not a guarantee of immediate generation. Online workers may be busy or incompatible with your dimensions. Choose by desired style and availability; then use aihorde_image_request submit/status/save. No generation is submitted by this read-only query.',
    parameters: {
      search: { type: 'string', description: 'Optional case-insensitive model name substring.' },
      online_only: { type: 'boolean', description: 'Default true: include only models with online workers.' },
      limit: { type: 'integer', description: '1–500, default 100; response marks truncation.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 35_000,
    presentCall: () => ({ card: 'generic', title: 'AI Horde live models', kind: 'read' }),
    execute(args, exec) {
      return run(async () => {
        const limit = args.limit ?? 100
        if (limit < 1 || limit > 500) throw new Error('limit must be between 1 and 500')
        if ((args.search?.length ?? 0) > 200) throw new Error('search must be at most 200 characters')
        const models = (await client.models(AbortSignal.any([exec.signal, shutdown.signal]))).filter(model =>
          (!(args.online_only ?? true) || model.workers > 0) && model.name.toLowerCase().includes(args.search?.toLowerCase() ?? ''))
          .sort((a, b) => (a.queueClearEstimateSeconds ?? Infinity) - (b.queueClearEstimateSeconds ?? Infinity)
          || b.workers - a.workers || a.name.localeCompare(b.name))
        return JSON.stringify({ observedAt: new Date().toISOString(), totalMatching: models.length, truncated: models.length > limit,
          models: models.slice(0, limit), estimateScope: 'model queue clearance; not request-specific and not guaranteed' })
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'aihorde_image_request',
    description: 'Track AI Horde image generation without blocking the agent while queued. First call aihorde_list_models, choose an exact suitable online model, then submit with prompt/output/model and optional dimensions/steps. submit returns request_id immediately; retain it. status reads waiting/processing/finished, estimatedWaitSeconds, queuePosition, eligibleWorkers and mightStall. Wait estimate and position are HORDE-WIDE, not limited to eligible workers; no completion guarantee. Check no more often than every 3 seconds and do useful work between checks. When done, save writes the PNG to the submitted output; cancel stops unwanted work. Only requests submitted by this tool in this session are accepted. Pending requests are cancelled on plugin unload; no restart persistence. Anonymous results are shared and have lowest priority. Keys are local AI_HORDE_API_KEY, never tool arguments.',
    parameters: {
      action: { type: 'string', required: true, enum: ['submit', 'status', 'save', 'cancel'] },
      request_id: { type: 'string', description: 'Required for status/save/cancel; ID returned by submit.' },
      prompt: { type: 'string', description: 'Required for submit, 1–4000 characters.' },
      output: { type: 'string', description: 'Required for submit: absolute NEW .png in an existing workspace directory.' },
      model: { type: 'string', description: 'Exact name from aihorde_list_models; omitted uses stable_diffusion.' },
      width: { type: 'integer', description: 'Submit only: multiple of 64, 256–1024; default 512.' },
      height: { type: 'integer', description: 'Submit only: multiple of 64, 256–1024; default 512.' },
      steps: { type: 'integer', description: 'Submit only: 1–50, default 20.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 40_000,
    presentCall: () => ({ card: 'generic', title: 'AI Horde image request', kind: 'edit' }),
    execute(args, exec) {
      return run(async () => {
        if (isDisposed()) throw new Error('AI Horde plugin is unloading')
        const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
        const signal = AbortSignal.any([exec.signal, shutdown.signal])
        const owner = JSON.stringify([policy.workspaceRoot, exec.agent?.session.id ?? ''])
        if (args.action === 'submit') {
          if (args.request_id !== undefined) throw new Error('submit does not accept request_id')
          if (policy.mode === 'read-only') throw new Error('Image generation requires workspace-write permission')
          if (requests.size + submitting >= 32) throw new Error('Save or cancel existing requests before submitting more (limit 32)')
          const input = imageInput(args)
          if (args.output === undefined) throw new Error('submit requires output')
          await validateImageDestination(args.output, policy.workspaceRoot)
          if (requests.size + submitting >= 32) throw new Error('Too many pending AI Horde requests')
          submitting++
          let id: string | undefined
          try {
            id = await client.submit(input, signal)
            signal.throwIfAborted()
            if (isDisposed()) throw new Error('AI Horde plugin is unloading')
            requests.set(id, { owner, workspace: policy.workspaceRoot, input, output: args.output, busy: false })
            return JSON.stringify({ request_id: id, state: 'submitted', next: 'Call status with this request_id; save when done.' })
          } catch (error) {
            if (id !== undefined) await client.cancel(id, AbortSignal.timeout(5000)).catch(() => undefined)
            throw error
          } finally { submitting-- }
        }
        if ([args.prompt, args.output, args.model, args.width, args.height, args.steps].some(value => value !== undefined)) {
          throw new Error('Generation parameters are only accepted with submit')
        }
        const id = args.request_id
        const record = id === undefined ? undefined : requests.get(id)
        if (id === undefined || record === undefined || record.owner !== owner) throw new Error('Unknown request in this session')
        if (args.action === 'status') return JSON.stringify({ ...(await client.check(id, signal)),
          observedAt: new Date().toISOString(), estimateScope: 'horde-wide; eligible workers may be busy; not guaranteed' })
        if (record.busy) throw new Error('Request is already being saved or cancelled')
        record.busy = true
        try {
          if (args.action === 'cancel') {
            await client.cancel(id, signal)
            requests.delete(id)
            return JSON.stringify({ request_id: id, state: 'cancelled' })
          }
          if (policy.mode === 'read-only') throw new Error('Image saving requires workspace-write permission')
          await validateImageDestination(record.output, record.workspace)
          const image = await client.collect(id, signal)
          const result = await saveHordeImage(record.output, record.workspace, record.input, image, signal)
          requests.delete(id)
          return result
        } finally { record.busy = false }
      })
    },
  }))
  return { run, shutdown: shutdown.signal }
}
