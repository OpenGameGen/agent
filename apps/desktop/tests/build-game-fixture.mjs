/** Build the browser smoke fixture with an installed engine after compiling desktop-host. */
import { mkdtemp, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageGame, installGameHarness } from '../../desktop-host/lib/types/game-build.js'

const engine = process.env.GODOT_TEST_BINARY
if (!engine) throw new Error('Set GODOT_TEST_BINARY to the Godot 4.6 executable')
const directory = await mkdtemp(join(tmpdir(), 'opengame-web-live-'))
const resources = fileURLToPath(new URL('../resources/godot/', import.meta.url))
await stageGame(fileURLToPath(new URL('./fixtures/browser-game/', import.meta.url)), join(directory, 'project'), new AbortController().signal)
await installGameHarness(join(directory, 'project'), resources)
await mkdir(join(directory, 'web'))
for (const args of [
  ['--script', join(resources, 'game-prepare.gd')],
  ['--editor', '--import'],
  ['--export-debug', 'OpenGame Web Test', join(directory, 'web/index.html')],
]) {
  const result = spawnSync(engine, ['--headless', '--path', join(directory, 'project'), ...args], { encoding: 'utf8', timeout: 120000 })
  if (result.status !== 0 || /SCRIPT ERROR:|Parse Error:|ERROR:/u.test(result.stdout + result.stderr)) {
    throw new Error(result.error?.message ?? result.stdout + result.stderr)
  }
}
console.log(join(directory, 'web'))
