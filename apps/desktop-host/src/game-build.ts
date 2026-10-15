/** Isolated Godot Web staging and loopback artifact serving. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { access, copyFile, lstat, mkdir, realpath, readdir, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

/** @param source - Source project. @param destination - Empty private staging directory. @param signal - Cancellation. */
export async function stageGame(source: string, destination: string, signal: AbortSignal): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal.throwIfAborted()
    if (entry.name.startsWith('.') || ['node_modules', 'opengame_test'].includes(entry.name)) continue
    if (entry.isSymbolicLink()) throw new Error(`Game staging refuses symlinks: ${entry.name}`)
    if (entry.isDirectory()) await stageGame(join(source, entry.name), join(destination, entry.name), signal)
    else if (entry.isFile()) await copyFile(join(source, entry.name), join(destination, entry.name))
  }
}

/** @param project - Staged copy. @param resources - Bundled scripts. */
export async function installGameHarness(project: string, resources: string): Promise<void> {
  await mkdir(join(project, 'opengame_test'))
  await copyFile(join(resources, 'game-bridge.gd'), join(project, 'opengame_test/bridge.gd'))
  await copyFile(join(resources, 'game-reproduce.gd'), join(project, 'opengame_test/game-reproduce.gd'))
  await copyFile(join(resources, 'game-shell.html'), join(project, 'opengame_test/shell.html'))
  await writeFile(join(project, 'export_presets.cfg'), `[preset.0]
name="OpenGame Web Test"
platform="Web"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
[preset.0.options]
variant/extensions_support=false
variant/thread_support=false
html/custom_html_shell="res://opengame_test/shell.html"
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
progressive_web_app/enabled=false
`)
}

/** Serve only one immutable export directory; URLs cannot traverse to source or Host data.
 * @param directory - Export artifact directory. @param runId - Random capability URL segment.
 * @returns Local URL and asynchronous shutdown.
 */
export async function serveGame(directory: string, runId: string) {
  const prefix = `/game/${runId}/`
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return }
        const pathname = decodeURIComponent(new URL(request.url ?? '', 'http://127.0.0.1').pathname)
        if (!pathname.startsWith(prefix)) { response.writeHead(404).end(); return }
        const name = pathname.slice(prefix.length) || 'index.html'
        const file = resolve(directory, name)
        if (!file.startsWith(resolve(directory) + sep) || name.includes('\\') || (await lstat(file)).isSymbolicLink()) { response.writeHead(403).end(); return }
        await access(file)
        if (!(await realpath(file)).startsWith(await realpath(directory) + sep)) { response.writeHead(403).end(); return }
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.pck': 'application/octet-stream' }
        response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        if (request.method === 'HEAD') response.end()
        else await pipeline(createReadStream(file), response)
      } catch (error) { if (!response.headersSent) response.writeHead(404); response.end(error instanceof Error ? 'Game artifact unavailable' : 'Not found') }
    })()
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const address = server.address()
  if (address === null || typeof address === 'string') { server.close(); throw new Error('Game server address unavailable') }
  return { url: `http://127.0.0.1:${address.port}${prefix}index.html`, close: () => new Promise<void>((accept, reject) => {
    server.close((error) => { if (error) reject(error); else accept() }); server.closeAllConnections()
  }) }
}

/** Content fingerprint uses exactly the staging exclusions, and rejects linked dependencies.
 * @param project - Source directory. @param signal - Cancellation. @returns Content digest.
 */
export async function gameFingerprint(project: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      signal.throwIfAborted()
      if (entry.name.startsWith('.') || ['node_modules', 'opengame_test'].includes(entry.name)) continue
      if (entry.isSymbolicLink()) throw new Error(`Game staging refuses symlinks: ${entry.name}`)
      const name = prefix + entry.name
      hash.update(JSON.stringify([name, entry.isDirectory() ? 'directory' : 'file']))
      if (entry.isDirectory()) await visit(join(directory, entry.name), name + '/')
      else if (entry.isFile()) {
        const content = createHash('sha256')
        for await (const chunk of createReadStream(join(directory, entry.name), { signal })) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary project content')
          content.update(chunk)
        }
        hash.update(content.digest())
      }
    }
  }
  await visit(project, '')
  return hash.digest('hex')
}

/** A deleted or incomplete preview cache cannot serve as a live or reusable export. */
export async function gameExportAvailable(directory: string): Promise<boolean> {
  try {
    const files = await Promise.all(['index.html', 'index.js', 'index.wasm', 'index.pck'].map(name => stat(join(directory, name))))
    return files.every(file => file.isFile() && file.size > 0)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return false
    throw error
  }
}
