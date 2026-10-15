/** Independent Cordis tool for official, browser-backed Perchance image generation. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { lstat, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createGameTransport, type GameTransport } from './game-transport.ts'

export const name = 'product-perchance-images'
export const inject = ['tools', 'sandboxPolicy']

/** Validate and save an exclusive PNG in an existing canonical workspace directory. */
export async function savePerchanceImage(output: string, workspace: string, payload: unknown, signal: AbortSignal): Promise<string> {
  if (!isAbsolute(output) || !output.toLowerCase().endsWith('.png')) throw new Error('output must be an absolute .png path in the workspace')
  const root = await realpath(workspace)
  const parent = await realpath(dirname(output))
  const delta = relative(root, parent)
  if (delta === '..' || delta.startsWith('..' + sep) || isAbsolute(delta)) throw new Error('Image output must be inside the workspace; symlinks outside it are rejected')
  if (typeof payload !== 'object' || payload === null || !('png' in payload) || typeof payload.png !== 'string'
    || payload.png.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.png)) throw new Error('Invalid Perchance image payload')
  const image = Buffer.from(payload.png, 'base64')
  if (image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || image.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Perchance returned no valid PNG image')
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20)
  if (width < 256 || height < 256 || width * height > 16777216) throw new Error('Generated PNG dimensions outside limits')
  signal.throwIfAborted()
  const path = join(parent, basename(output))
  // Never overwrite an existing asset (including symlinks). Cancellation after a
  // completed write leaves the useful file in place, as reported by the tool.
  await writeFile(path, image, { flag: 'wx', mode: 0o600 })
  return JSON.stringify({ provider: 'perchance', path, width, height, bytes: image.length,
    sha256: createHash('sha256').update(image).digest('hex') })
}

/** Mount with the production private Desktop carrier. */
export function apply(ctx: Context): void {
  const transport = createGameTransport('perchance:')
  ctx.effect(() => () => { transport.dispose() })
  registerPerchanceImages(ctx, transport.request)
}

/** Public tool registration with a replaceable browser provider for focused tests. */
export function registerPerchanceImages(ctx: Context, transport: GameTransport): void {
  ctx.tools.register(defineTool({
    name: 'perchance_generate_image',
    description: 'Generate free artwork and save the first completed image through the official Perchance webpage in a dedicated ordinary Desktop Sidebar browser tab; no login or API key. Sends prompt to perchance.org. Save as a new PNG in an EXISTING workspace directory; never overwrites files. Attempts one unambiguous human-confirmation checkbox in its official tab; complex or inaccessible verification requires the user. Website verification, queue, network and layout changes can fail the call: complete any verification in the Perchance image-generation tab and retry only when instructed. Returns the saved image path, dimensions and SHA-256. This creates raster artwork, not transparent sprites or edited reference images. Use the returned file in the project and read_image to inspect it. Requires the Desktop shell.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image description, 1–4000 characters. English descriptive prompts are preferred.' },
      output: { type: 'string', required: true, description: 'Absolute NEW .png file path inside the workspace; parent directory must exist.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 250_000,
    presentCall: () => ({ card: 'generic', title: 'Perchance image generation', kind: 'edit' }),
    async execute(args, exec) {
      if (!args.prompt.trim() || args.prompt.length > 4000) throw new Error('Prompt must contain 1–4000 characters')
      const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      if (policy.mode === 'read-only') throw new Error('Image generation requires workspace-write permission')
      // Validate the destination before starting external generation.
      if (!isAbsolute(args.output) || !args.output.toLowerCase().endsWith('.png')) throw new Error('output must be an absolute .png path')
      const root = await realpath(policy.workspaceRoot), parent = await realpath(dirname(args.output))
      const delta = relative(root, parent)
      if (delta === '..' || delta.startsWith('..' + sep) || isAbsolute(delta)) throw new Error('Image output must be inside the workspace')
      try { await lstat(args.output); throw new Error('Image output already exists; choose a new filename') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      exec.signal.throwIfAborted()
      const result = await transport('generate', { prompt: args.prompt, sessionId: exec.agent?.session.id ?? '' }, exec.signal)
      return savePerchanceImage(args.output, root, result, exec.signal)
    },
  }))
}
