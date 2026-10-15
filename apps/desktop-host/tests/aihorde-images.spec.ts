import { mkdtemp, realpath, rm, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { registerHordeImages } from '../src/aihorde-images.ts'
import { createHordeClient, generateHordeImage } from '../src/aihorde-api.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function root() { const value = await realpath(await mkdtemp(join(tmpdir(), 'horde-test-'))); roots.push(value); return value }
const id = '00000000-0000-0000-0000-000000000001'
const input = { prompt: 'blue robot', width: 512, height: 512, steps: 20 }
async function image() { return sharp({ create: { width: 512, height: 512, channels: 3, background: '#0000ff' } }).webp().toBuffer() }
function transport(values: unknown[]) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(values.shift()), { status: 200 }))
}
it('submits official inline request, polls, and returns worker request metadata', async () => {
  const bytes = await image()
  const request = transport([{ id }, { done: false, is_possible: true }, { done: true }, { done: true, generations: [{ img: bytes.toString('base64'), model: 'worker-model', seed: '42' }] }])
  const result = await generateHordeImage(input, new AbortController().signal, undefined, request, 1)
  expect(result).toMatchObject({ requestId: id, model: 'worker-model', seed: '42', shared: true, data: bytes })
  expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toMatchObject({ r2: false, shared: false, params: { n: 1, width: 512 } })
  expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ apikey: '0000000000' })
  expect(request.mock.calls.map(call => call[0])).toContain('https://aihorde.net/api/v2/generate/check/' + id)
})
it.each([
  [{ done: false, faulted: true }, 'faulted'],
  [{ done: false, is_possible: false }, 'No AI Horde worker'],
])('cleans remote jobs on failure %j', async (check, message) => {
  const request = transport([{ id }, check, {}])
  await expect(generateHordeImage(input, new AbortController().signal, undefined, request, 1)).rejects.toThrow(message)
  expect(request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
})
it('cancels a pending job using a fresh bounded cleanup signal', async () => {
  const controller = new AbortController()
  const request = vi.fn<typeof fetch>(async (_url, options) => {
    if (options?.method === 'POST') return Response.json({ id })
    if (options?.method === 'DELETE') { expect(options.signal?.aborted).toBe(false); return Response.json({}) }
    controller.abort(); return Response.json({ done: false })
  })
  await expect(generateHordeImage(input, controller.signal, undefined, request, 1000)).rejects.toThrow()
  expect(request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
})
it.each(['https://example.com/image.webp', 'aW52YWxpZA=='])('rejects unsafe image result %s', async (img) => {
  const request = transport([{ id }, { done: true }, { done: true, generations: [{ img }] }, {}])
  await expect(generateHordeImage(input, new AbortController().signal, undefined, request)).rejects.toThrow()
})
it('reports HTTP failure without reflecting response bodies or credentials', async () => {
  const request = vi.fn<typeof fetch>(async () => new Response('private credential', { status: 403 }))
  await expect(generateHordeImage(input, new AbortController().signal, 'secret', request)).rejects.toThrow('AI Horde HTTP 403')
})
it('mounts/disposes public tool, saves decoded PNG and rejects overwrite, escapes, dimensions and read-only policy', async () => {
  const workspace = await root(), outside = await root()
  await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const generate = vi.fn(async () => ({ data: await image(), requestId: id, model: 'fixture', seed: '1', shared: true }))
  for (const mode of ['workspace-write', 'read-only'] as const) {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt); await ctx.plugin(Projections); await ctx.plugin(Tools)
      await ctx.plugin(Policy, { mode, workspaceRoot: workspace })
      const fiber = await ctx.plugin({ name: 'fixture-horde', inject: ['tools', 'sandboxPolicy'], apply(scope: Context) { registerHordeImages(scope, generate) } })
      await fiber.await()
      const schema = ctx.tools.schemas().find(tool => tool.name === 'aihorde_generate_image')
      expect(schema).toBeDefined()
      await expect(JSON.stringify(schema, null, 2)).toMatchFileSnapshot('./expected/aihorde-tool.json')
      const call = (output: string, extra = {}) => ctx.tools.execute({ callId: ToolCallId('horde-test'), name: 'aihorde_generate_image', arguments: { prompt: 'robot', output, ...extra }, signal: new AbortController().signal })
      const path = join(workspace, mode + '.png')
      const result = await call(path)
      expect(result.isError).toBe(mode === 'read-only')
      if (mode === 'workspace-write') {
        expect(await sharp(await readFile(path)).metadata()).toMatchObject({ format: 'png', width: 512, height: 512 })
        const count = generate.mock.calls.length
        for (const output of [path, join(outside, 'x.png'), join(workspace, 'escape/x.png'), 'relative.png']) expect((await call(output)).isError).toBe(true)
        expect((await call(join(workspace, 'bad.png'), { width: 513 })).isError).toBe(true)
        expect(generate.mock.calls.length).toBe(count)
        expect((await call(join(workspace, 'mismatch.png'), { width: 768 })).isError).toBe(true)
      }
      await fiber.dispose()
      expect(ctx.tools.schemas().some(tool => tool.name === 'aihorde_generate_image')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  }
  expect(generate).toHaveBeenCalledTimes(2)
})


it('exposes model and request estimates with unknown values preserved, and validates IDs before HTTP', async () => {
  const request = transport([[{ name: 'Online', count: 2, jobs: 7, eta: 40 }, { name: 'Offline', count: 0 }],
    { done: false, waiting: 1, processing: 0, finished: 0, wait_time: 120, queue_position: 8,
      eligible_workers: 2, eligible_worker_threads: 3, is_possible: true, might_stall: false }])
  const client = createHordeClient(undefined, request), signal = new AbortController().signal
  expect(await client.models(signal)).toEqual([
    { name: 'Online', workers: 2, queuedJobs: 7, queueClearEstimateSeconds: 40 },
    { name: 'Offline', workers: 0, queuedJobs: null, queueClearEstimateSeconds: null },
  ])
  expect(await client.check(id, signal)).toMatchObject({ waiting: 1, estimatedWaitSeconds: 120, queuePosition: 8,
    eligibleWorkers: 2, eligibleWorkerThreads: 3, mightStall: false, restarted: null })
  await expect(client.check('../escape', signal)).rejects.toThrow('Invalid AI Horde request ID')
  expect(request).toHaveBeenCalledTimes(2)
})

it('runs discovery, submit, status, save, cancellation and unload cleanup through public tools', async () => {
  const workspace = await root(), signal = new AbortController().signal
  const client = {
    models: vi.fn(async () => [
      { name: 'Offline', workers: 0, queuedJobs: 0, queueClearEstimateSeconds: 0 },
      { name: 'Busy', workers: 4, queuedJobs: 5, queueClearEstimateSeconds: 50 },
      { name: 'Quick', workers: 2, queuedJobs: 0, queueClearEstimateSeconds: 0 },
    ]),
    submit: vi.fn(async () => id),
    check: vi.fn(async () => ({ requestId: id, done: true, faulted: false, waiting: 0, processing: 0, finished: 1,
      restarted: 0, estimatedWaitSeconds: 0, queuePosition: 0, possible: true, eligibleWorkers: 2,
      eligibleWorkerThreads: 2, mightStall: false })),
    collect: vi.fn(async () => ({ data: await image(), requestId: id, model: 'Quick', seed: '42', shared: true })),
    cancel: vi.fn(async () => {}),
  }
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Projections); await ctx.plugin(Tools)
    await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: workspace })
    const fiber = await ctx.plugin({ name: 'interactive-horde', inject: ['tools', 'sandboxPolicy'],
      apply(scope: Context) { registerHordeImages(scope, async () => client.collect(), client) } })
    await fiber.await()
    await expect(JSON.stringify(ctx.tools.schemas(), null, 2)).toMatchFileSnapshot('./expected/aihorde-tools.json')
    const call = (name: string, args: object) => ctx.tools.execute({ callId: ToolCallId('interactive'), name, arguments: args, signal })
    const read = (result: Awaited<ReturnType<typeof call>>) => {
      expect(result.isError).toBe(false)
      return JSON.parse(result.value as string) as Record<string, unknown>
    }
    const models = read(await call('aihorde_list_models', { limit: 1 }))
    expect(models).toMatchObject({ totalMatching: 2, truncated: true, models: [{ name: 'Quick' }] })
    expect((await call('aihorde_list_models', { limit: 0 })).isError).toBe(true)
    expect((await call('aihorde_image_request', { action: 'status', request_id: id })).isError).toBe(true)
    expect(client.check).not.toHaveBeenCalled()
    const output = join(workspace, 'tracked.png')
    expect(read(await call('aihorde_image_request', { action: 'submit', prompt: 'robot', output, model: 'Quick' })))
      .toMatchObject({ request_id: id, state: 'submitted' })
    expect(read(await call('aihorde_image_request', { action: 'status', request_id: id })))
      .toMatchObject({ done: true, finished: 1, eligibleWorkers: 2 })
    client.collect.mockRejectedValueOnce(new Error('Request is still waiting'))
    expect((await call('aihorde_image_request', { action: 'save', request_id: id })).isError).toBe(true)
    expect(read(await call('aihorde_image_request', { action: 'save', request_id: id })))
      .toMatchObject({ path: output, width: 512, model: 'Quick' })
    expect((await call('aihorde_image_request', { action: 'save', request_id: id })).isError).toBe(true)
    await call('aihorde_image_request', { action: 'submit', prompt: 'robot', output: join(workspace, 'cancel.png') })
    expect(read(await call('aihorde_image_request', { action: 'cancel', request_id: id }))).toMatchObject({ state: 'cancelled' })
    await call('aihorde_image_request', { action: 'submit', prompt: 'robot', output: join(workspace, 'unload.png') })
    await fiber.dispose()
    expect(client.cancel).toHaveBeenCalledTimes(2)
    expect(ctx.tools.schemas()).toEqual([])
  } finally { await ctx.fiber.dispose() }
})


it('allows read-only discovery but refuses submission without contacting the generation endpoint', async () => {
  const ctx = new Context(), workspace = await root(), request = transport([[{ name: 'Online', count: 2, eta: 0 }]])
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Projections); await ctx.plugin(Tools)
    await ctx.plugin(Policy, { mode: 'read-only', workspaceRoot: workspace })
    const fiber = await ctx.plugin({ name: 'read-only-horde', inject: ['tools', 'sandboxPolicy'],
      apply(scope: Context) { registerHordeImages(scope, async () => { throw new Error('must not generate') }, createHordeClient(undefined, request)) } })
    await fiber.await()
    const call = (name: string, args: object) => ctx.tools.execute({ callId: ToolCallId('read-only'), name,
      arguments: args, signal: new AbortController().signal })
    expect((await call('aihorde_list_models', {})).isError).toBe(false)
    expect((await call('aihorde_image_request', { action: 'submit', prompt: 'robot', output: join(workspace, 'x.png') })).isError).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  } finally { await ctx.fiber.dispose() }
})

it('awaits an in-flight submission and cancels its late ID before unload completes', async () => {
  const entered = Promise.withResolvers<undefined>(), response = Promise.withResolvers<Response>()
  const request = vi.fn<typeof fetch>(async (_url, options) => {
    if (options?.method === 'POST') { entered.resolve(undefined); return response.promise }
    return Response.json({})
  })
  const ctx = new Context(), workspace = await root()
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Projections); await ctx.plugin(Tools)
    await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: workspace })
    const fiber = await ctx.plugin({ name: 'late-horde', inject: ['tools', 'sandboxPolicy'],
      apply(scope: Context) { registerHordeImages(scope, async () => { throw new Error('unused') }, createHordeClient(undefined, request)) } })
    await fiber.await()
    const call = ctx.tools.execute({ callId: ToolCallId('late'), name: 'aihorde_image_request',
      arguments: { action: 'submit', prompt: 'robot', output: join(workspace, 'late.png') }, signal: new AbortController().signal })
    await entered.promise
    let disposed = false
    const unloading = fiber.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    response.resolve(Response.json({ id }))
    expect((await call).isError).toBe(true)
    await unloading
    expect(request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
    expect(ctx.tools.schemas()).toEqual([])
  } finally { response.resolve(Response.json({ id })); await ctx.fiber.dispose() }
})
