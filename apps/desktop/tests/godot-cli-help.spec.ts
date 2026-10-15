import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { projectCommand } from '../resources/godot/cli.mjs'
import type { Runtime } from '../resources/godot/runtime.mjs'
const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'godot-cli-help-')); roots.push(path); return path }
const localGodot = '/Applications/Godot.app/Contents/MacOS/Godot'

it('shows subcommand help before touching runtime and diagnoses flags in the project position', async () => {
  const ensureEngine = vi.fn(async () => { throw new Error('Unexpected engine installation') })
  const status = vi.fn(async () => { throw new Error('Unexpected runtime lookup') })
  const unavailable = { ensureEngine, status } as unknown as Runtime
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    for (const command of ['run', 'check', 'editor', 'export', 'install', 'status']) {
      expect(await projectCommand([command, '--help'], unavailable)).toBe(0)
      expect(await projectCommand([command, '-h'], unavailable)).toBe(0)
    }
    expect(output.mock.calls.flat().join('\n')).toContain('arguments after it are for your game script')
    for (const args of [['run', '--headless', '--quit-after', '120', '/project'], ['run'], ['check', '--headless']]) {
      await expect(projectCommand(args, unavailable)).rejects.toThrow('Put the project path before flags')
    }
    expect(ensureEngine).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  } finally { output.mockRestore() }
})

it.skipIf(process.platform !== 'darwin' || spawnSync(localGodot, ['--version']).status !== 0)('real CLI preserves the Godot user-argument separator and engine help forwarding', async () => {
  const directory = await root()
  await writeFile(join(directory, 'project.godot'), 'config_version=5\n')
  await writeFile(join(directory, 'args.gd'), 'extends SceneTree\nfunc _initialize():\n\tassert(OS.get_cmdline_user_args() == PackedStringArray(["--level", "2"]))\n\tprint("USER_ARGS_PRESERVED")\n\tquit()\n')
  const cli = new URL('../resources/godot/cli.mjs', import.meta.url).href
  const runner = `import { projectCommand } from ${JSON.stringify(cli)}; process.exitCode = await projectCommand(JSON.parse(process.argv[1]), { executable: ${JSON.stringify(localGodot)}, ensureEngine: async () => ${JSON.stringify(localGodot)} });`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', runner, JSON.stringify(['run', directory, '--headless', '--script', 'res://args.gd', '--', '--level', '2'])], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain('USER_ARGS_PRESERVED')
  const help = spawnSync(process.execPath, ['--input-type=module', '-e', runner, JSON.stringify(['run', directory, '--help'])], { encoding: 'utf8', timeout: 10000 })
  expect(help.status, help.stdout + help.stderr).toBe(0)
  expect(help.stdout).toContain('Godot Engine')
})
