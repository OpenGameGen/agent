import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { savePerchanceImage } from '../src/perchance-images.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); directories.length = 0 })
async function root() { const path = await mkdtemp(join(tmpdir(), 'perchance-test-')); directories.push(path); return realpath(path) }
function payload() {
  const bytes = Buffer.alloc(24)
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes)
  bytes.write('IHDR', 12); bytes.writeUInt32BE(512,16); bytes.writeUInt32BE(512,20)
  return { png: bytes.toString('base64') }
}
it('saves exclusively, returns a manifest and refuses overwrite', async () => {
  const workspace = await root(), path = join(workspace, 'image.png')
  const result = JSON.parse(await savePerchanceImage(path, workspace, payload(), new AbortController().signal)) as Record<string, unknown>
  expect(result).toMatchObject({ path, width: 512, height: 512, bytes: 24, provider: 'perchance' })
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
  await expect(savePerchanceImage(path, workspace, payload(), new AbortController().signal)).rejects.toThrow()
  expect((await readFile(path)).toString('base64')).toBe(payload().png)
})
it('rejects escape paths, symlink parents, existing symlink files, invalid data and cancellation', async () => {
  const workspace = await root(), outside = await root(), signal = new AbortController().signal
  await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of [join(outside, 'x.png'), join(workspace, 'escape/x.png'), 'relative.png', join(workspace,'x.jpg')]) {
    await expect(savePerchanceImage(path, workspace, payload(), signal)).rejects.toThrow()
  }
  await writeFile(join(outside, 'existing.png'), 'preserve')
  await symlink(join(outside, 'existing.png'), join(workspace,'link.png'))
  await expect(savePerchanceImage(join(workspace, 'link.png'), workspace, payload(), signal)).rejects.toThrow()
  expect(await readFile(join(outside, 'existing.png'), 'utf8')).toBe('preserve')
  await expect(savePerchanceImage(join(workspace, 'invalid.png'), workspace, { png: 'bm90IGFuIGltYWdl' }, signal)).rejects.toThrow()
  const controller = new AbortController(); controller.abort()
  await expect(savePerchanceImage(join(workspace, 'cancelled.png'), workspace, payload(), controller.signal)).rejects.toThrow()
  await mkdir(join(workspace,'valid'))
})

it('registers through public Cordis tools, enforces policy before browsing, and disposes its schema', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { default: Tools } = await import('@deepseek-ai/dsh-tools')
  const { default: Projections } = await import('@deepseek-ai/dsh-session-projection')
  const { default: Policy } = await import('@deepseek-ai/dsh-sandbox-policy')
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const { registerPerchanceImages } = await import('../src/perchance-images.ts')
  const workspace = await root()
  for (const mode of ['workspace-write', 'read-only'] as const) {
    const ctx = new Context()
    let browsed = 0
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(Projections)
      await ctx.plugin(Tools)
      await ctx.plugin(Policy, { mode, workspaceRoot: workspace })
      const plugin = { name: 'fixture-perchance', inject: ['tools', 'sandboxPolicy'], apply(scope: InstanceType<typeof Context>) {
        registerPerchanceImages(scope, async () => { browsed++; return payload() })
      } }
      const fiber = await ctx.plugin(plugin)
      await fiber.await()
      expect(ctx.tools.schemas().some(tool => tool.name === 'perchance_generate_image')).toBe(true)
      const result = await ctx.tools.execute({ callId: ToolCallId('image-1'), name: 'perchance_generate_image',
        arguments: { prompt: 'blue robot', output: join(workspace, mode + '.png') }, signal: new AbortController().signal })
      expect(result.isError).toBe(mode === 'read-only')
      expect(browsed).toBe(mode === 'read-only' ? 0 : 1)
      await fiber.dispose()
      expect(ctx.tools.schemas().some(tool => tool.name === 'perchance_generate_image')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  }
})
