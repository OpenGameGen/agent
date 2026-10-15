import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
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
import { HordeHttpError, type HordeInput } from '../src/aihorde-api.ts'
import { registerGenerateImage, type Config } from '../src/generate-image.ts'
import { fetchModelReferences, rankImageModels } from '../src/image-routing.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const id = '00000000-0000-0000-0000-000000000001'
const references = { Anime: { style: 'anime', description: 'Cartoon art', inpainting: false },
  General: { style: 'generalist', description: 'General art', inpainting: false } }
async function fixture(config: Config = {}, mode: 'workspace-write' | 'read-only' = 'workspace-write') {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'image-router-'))); roots.push(workspace)
  const webp = await sharp({ create: { width: 512, height: 512, channels: 3, background: 'blue' } }).webp().toBuffer()
  const png = await sharp(webp).png().toBuffer(), sequence: string[] = []
  const horde = {
    models: vi.fn(async () => [{ name: 'Anime', workers: 3, queuedJobs: 0, queueClearEstimateSeconds: 0 },
      { name: 'General', workers: 5, queuedJobs: 0, queueClearEstimateSeconds: 0 }]),
    submit: vi.fn(async (_input: HordeInput) => { sequence.push('submit'); return id }),
    check: vi.fn(async () => ({ requestId: id, done: true, faulted: false, waiting: 0, processing: 0, finished: 1,
      restarted: 0, estimatedWaitSeconds: 0, queuePosition: 0, possible: true,
      eligibleWorkers: 3, eligibleWorkerThreads: 3, mightStall: false })),
    collect: vi.fn(async () => ({ data: webp, requestId: id, model: 'Anime', seed: '42', shared: true })),
    cancel: vi.fn(async () => { sequence.push('cancel') }),
  }
  const metadata = vi.fn(async () => references)
  const perchance = vi.fn(async (operation: string) => {
    sequence.push(operation)
    if (operation === 'probe') return { reachable: true, ready: true }
    return { png: png.toString('base64') }
  })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt); await ctx.plugin(Projections); await ctx.plugin(Tools)
  await ctx.plugin(Policy, { mode, workspaceRoot: workspace })
  const fiber = await ctx.plugin({ name: 'test-image-router', inject: ['tools', 'sandboxPolicy', 'systemPrompt'],
    apply(scope: Context) { registerGenerateImage(scope, { horde, references: metadata, perchance }, config) } })
  await fiber.await()
  const controller = new AbortController()
  const call = (extra = {}) => ctx.tools.execute({ callId: ToolCallId('unified'), name: 'generate_image',
    arguments: { prompt: 'A friendly anime robot', output: join(workspace, 'robot.png'), ...extra }, signal: controller.signal })
  return { ctx, fiber, horde, metadata, perchance, workspace, sequence, controller, call }
}
function manifest(result: { isError?: boolean; value?: unknown }) {
  expect(result.isError).toBe(false)
  return JSON.parse(result.value as string) as Record<string, unknown>
}
it('chooses online style-matched Horde first, ignores forced provider/model, probes both and saves PNG', async () => {
  const f = await fixture()
  try {
    await expect(JSON.stringify(f.ctx.tools.schemas(), null, 2)).toMatchFileSnapshot('./expected/generate-image-tool.json')
    expect(manifest(await f.call({ provider: 'perchance', model: 'General' })))
      .toMatchObject({ provider: 'aihorde', model: 'Anime', width: 512 })
    expect(f.horde.submit.mock.calls[0]?.[0]).toMatchObject({ model: 'Anime' })
    expect(f.perchance).toHaveBeenCalledTimes(1)
    expect(await sharp(await readFile(join(f.workspace, 'robot.png'))).metadata()).toMatchObject({ format: 'png' })
    await f.fiber.dispose(); expect(f.ctx.tools.schemas()).toEqual([])
  } finally { await f.ctx.fiber.dispose() }
})
it('uses Perchance when matching models queue too long rather than silently picking the wrong style', async () => {
  const f = await fixture()
  f.horde.models.mockResolvedValue([{ name: 'Anime', workers: 3, queuedJobs: 10, queueClearEstimateSeconds: 300 },
    { name: 'General', workers: 5, queuedJobs: 0, queueClearEstimateSeconds: 0 }])
  try { expect(manifest(await f.call()).provider).toBe('perchance'); expect(f.horde.submit).not.toHaveBeenCalled() }
  finally { await f.ctx.fiber.dispose() }
})
it('cancels queued work before switching after the horde-wide request estimate grows', async () => {
  const f = await fixture()
  f.horde.check.mockResolvedValue({ requestId: id, done: false, faulted: false, waiting: 1, processing: 0, finished: 0,
    restarted: 0, estimatedWaitSeconds: 600, queuePosition: 200, possible: true,
    eligibleWorkers: 3, eligibleWorkerThreads: 3, mightStall: false })
  try {
    expect(manifest(await f.call()).provider).toBe('perchance')
    expect(f.sequence.indexOf('cancel')).toBeLessThan(f.sequence.indexOf('generate'))
  } finally { await f.ctx.fiber.dispose() }
})
it.each(['api', 'metadata'])('falls back when Horde %s is unreachable', async (source) => {
  const f = await fixture()
  if (source === 'api') f.horde.models.mockRejectedValue(new Error('network unavailable'))
  else f.metadata.mockRejectedValue(new Error('metadata unavailable'))
  try { expect(manifest(await f.call()).provider).toBe('perchance') }
  finally { await f.ctx.fiber.dispose() }
})
it('does not let an inaccessible Perchance block an available Horde', async () => {
  const f = await fixture(); f.perchance.mockRejectedValue(new Error('browser network blocked'))
  try { expect(manifest(await f.call()).provider).toBe('aihorde') }
  finally { await f.ctx.fiber.dispose() }
})
it('reports both network failures without submitting either generation', async () => {
  const f = await fixture()
  f.horde.models.mockRejectedValue(new Error('DNS fail')); f.perchance.mockRejectedValue(new Error('blocked'))
  try {
    const result = await f.call(); expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Network checks'); expect(f.horde.submit).not.toHaveBeenCalled()
  } finally { await f.ctx.fiber.dispose() }
})
it('stops rather than generate twice when cancellation cannot be confirmed', async () => {
  const f = await fixture()
  f.horde.check.mockRejectedValue(new Error('service failed')); f.horde.cancel.mockRejectedValue(new Error('network failed'))
  try { expect((await f.call()).isError).toBe(true); expect(f.sequence).not.toContain('generate') }
  finally { await f.ctx.fiber.dispose() }
})
it('caller cancellation cleans Horde work and never starts fallback', async () => {
  const f = await fixture()
  f.horde.check.mockImplementation(async () => { f.controller.abort(); throw new Error('cancelled') })
  try {
    expect((await f.call()).isError).toBe(true); expect(f.horde.cancel).toHaveBeenCalledTimes(1)
    expect(f.sequence).not.toContain('generate')
  } finally { await f.ctx.fiber.dispose() }
})
it('read-only policy and invalid destinations fail before either network probe', async () => {
  for (const mode of ['read-only', 'workspace-write'] as const) {
    const f = await fixture({}, mode)
    try {
      expect((await f.call(mode === 'workspace-write' ? { output: '/outside/robot.png' } : {})).isError).toBe(true)
      expect(f.horde.models).not.toHaveBeenCalled(); expect(f.perchance).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  }
})
it('uses official pixel metadata and excludes offline/inpainting models', () => {
  const result = rankImageModels('pixel art', undefined, [
    { name: 'Pixel', workers: 2, queuedJobs: 0, queueClearEstimateSeconds: 0 },
    { name: 'Offline', workers: 0, queuedJobs: 0, queueClearEstimateSeconds: 0 },
    { name: 'Inpaint', workers: 4, queuedJobs: 0, queueClearEstimateSeconds: 0 },
  ], { Pixel: { style: 'other', description: 'Pixel art sprites', inpainting: false },
    Offline: { style: 'other', description: 'Pixel art', inpainting: false },
    Inpaint: { style: 'other', description: 'Pixel art', inpainting: true } })
  expect(result.candidates.map(model => model.name)).toEqual(['Pixel'])
})
it('uses the official metadata mirror after primary failure and rejects invalid data', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ Anime: { style: 'anime', description: 'Art' } }))
  expect(await fetchModelReferences(new AbortController().signal, 1000, request)).toMatchObject({ Anime: { style: 'anime' } })
  expect(request.mock.calls[1]?.[0]).toContain('raw.githubusercontent.com/Haidra-Org')
  const invalid = vi.fn<typeof fetch>(async () => Response.json([]))
  await expect(fetchModelReferences(new AbortController().signal, 1000, invalid)).rejects.toThrow('metadata unreachable or invalid')
})
it('distinguishes service HTTP rejection from network failure', async () => {
  const f = await fixture(); f.horde.models.mockRejectedValue(new HordeHttpError(403))
  try {
    expect(manifest(await f.call())).toMatchObject({ provider: 'perchance',
      routing: { network: { aihorde: { reachable: true, ready: false, reason: 'model_api_http_403' } } } })
  } finally { await f.ctx.fiber.dispose() }
})
it('does not generate through a Perchance endpoint that answered HTTP 503', async () => {
  const f = await fixture(); f.perchance.mockRejectedValue(new Error('Perchance image-generation endpoint unavailable: HTTP 503'))
  try {
    expect(manifest(await f.call())).toMatchObject({ provider: 'aihorde',
      routing: { network: { perchance: { reachable: true, ready: false, reason: 'generation_endpoint_http_503' } } } })
  } finally { await f.ctx.fiber.dispose() }
})
it('does not duplicate generation when the submit response is lost before receiving its ID', async () => {
  const f = await fixture(); f.horde.submit.mockRejectedValue(new Error('response lost'))
  try {
    const result = await f.call(); expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('submission outcome unknown'); expect(f.sequence).not.toContain('generate')
  } finally { await f.ctx.fiber.dispose() }
})
