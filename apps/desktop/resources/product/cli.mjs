/** Reuse the supported dsh CLI/profile loader with product-owned storage. */
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { productEnvironment } from './identity.mjs'
Object.assign(process.env, productEnvironment())
const support = resolve(import.meta.dirname, '..')
const runtime = join(dirname(support), 'app.asar', 'dsh')
const entry = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
const { runDesktopCli } = await import(pathToFileURL(entry).href)
if (process.platform === 'win32') {
  const { installWindowsCliSignals } = await import(pathToFileURL(join(dirname(entry), 'windows-cli-signals.js')).href)
  await installWindowsCliSignals()
}
await runDesktopCli(runtime, support)
