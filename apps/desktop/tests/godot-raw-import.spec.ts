import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { rawImportProjectConfig } from '../resources/godot/cli.mjs'

it('recognizes only one explicit headless editor import project before user arguments', async () => {
  const project = await mkdtemp(join(tmpdir(), 'raw import '))
  try {
    await writeFile(join(project, 'project.godot'), 'config_version=5\n')
    const base = ['--headless', '--path', project, '--editor', '--import']
    const expected = join(await realpath(project), 'project.godot')
    expect(await rawImportProjectConfig(base)).toBe(expected)
    expect(await rawImportProjectConfig([...base, '--', '--path', '/other', '--version'])).toBe(expected)
    for (const args of [
      [...base, '--path', project], [...base, '--main-pack', 'game.pck'], [...base, '--upwards'],
      [...base, '--version'], [...base, '--help'], [...base, '--unknown'], [...base, '--editor'],
      ['--', ...base], ['++', ...base], ['--headless', '--editor', '--import'],
      ['--headless', '--editor', '--import', '--path', '/definitely/missing/project'],
    ]) expect(await rawImportProjectConfig(args)).toBeUndefined()
  } finally { await rm(project, { recursive: true, force: true }) }
})

const engine = '/Applications/Godot.app/Contents/MacOS/Godot'
const available = process.platform === 'darwin' && spawnSync(engine, ['--version']).status === 0
it.skipIf(!available)('raw import fails fast for malformed config and keeps legal autoload and user arguments unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-import-engine-'))
  const project = join(root, 'project')
  try {
    await mkdir(project)
    await mkdir(join(root, 'engine'))
    await symlink('/Applications/Godot.app', join(root, 'engine/Godot.app'))
    await writeFile(join(root, 'engine/installed.json'), '{}')
    const cli = fileURLToPath(new URL('../resources/godot/cli.mjs', import.meta.url))
    const run = (args: string[]) => spawnSync(process.execPath, [cli, '--runtime', root, '--python', 'python3', '--mode', 'engine', '--headless', '--path', project, ...args], { encoding: 'utf8', timeout: 15000 })
    await writeFile(join(project, 'project.godot'), 'config_version=5\n[input]\nleft={"events":[Object(InputEventKey,{"physical_keycode":65})]}\n')
    const start = Date.now()
    const bad = run(['--editor', '--import'])
    expect(bad.status, bad.stdout + bad.stderr).toBe(1)
    expect(Date.now() - start).toBeLessThan(10000)
    expect(bad.stderr).toContain('project.godot parsing failed')
    await writeFile(join(project, 'project.godot'), 'config_version=5\n[autoload]\nCounter="*res://counter.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    await writeFile(join(project, 'counter.gd'), 'extends Node\nfunc _ready(): print("RAW_AUTOLOAD_ONCE")\n')
    await writeFile(join(project, 'entry.gd'), 'extends SceneTree\nfunc _initialize():\n\tprint("USER_ARGS=",OS.get_cmdline_user_args())\n\tquit()\n')
    const imported = run(['--editor', '--import', '--', '--path', '/ignored'])
    expect(imported.status, imported.stdout + imported.stderr).toBe(0)
    const once = run(['--script', 'res://entry.gd', '--', '--editor', '--import'])
    expect(once.status, once.stdout + once.stderr).toBe(0)
    expect(once.stdout.split('RAW_AUTOLOAD_ONCE')).toHaveLength(2)
    expect(once.stdout).toContain('--import')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
