import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
const engine = '/Applications/Godot.app/Contents/MacOS/Godot'
const available = process.platform === 'darwin' && spawnSync(engine, ['--version']).status === 0
it.skipIf(!available)('validates missing and invalid startup scenes and accepts overrides, native UIDs and binary scenes', async () => {
  const project = await mkdtemp(join(tmpdir(), 'game-prepare-'))
  const prepare = fileURLToPath(new URL('../resources/godot/game-prepare.gd', import.meta.url))
  const config = (scene?: string) => '[application]\nconfig/name="PrepareFixture"\n' + (scene === undefined ? '' : `run/main_scene="${scene}"\n`) + '[rendering]\nrenderer/rendering_method="gl_compatibility"\n'
  const run = (...args: string[]) => spawnSync(engine, ['--headless', '--path', project, ...args], { encoding: 'utf8', timeout: 15000 })
  try {
    await mkdir(join(project, 'opengame_test'))
    await writeFile(join(project, 'opengame_test/bridge.gd'), 'extends Node\n')
    await writeFile(join(project, 'main.tscn'), '[gd_scene format=3 uid="uid://b123456789abc"]\n[node name="Main" type="Node2D"]\n')
    await writeFile(join(project, 'project.godot'), config())
    expect(run('--editor', '--import').status).toBe(0)
    const missing = run('--script', prepare)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('application/run/main_scene')
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(config())
    expect(run('--script', prepare, '--', 'res://main.tscn').status).toBe(0)
    await writeFile(join(project, 'project.godot'), config('uid://b123456789abc'))
    expect(run('--script', prepare).status).toBe(0)
    await writeFile(join(project, 'save.gd'), 'extends SceneTree\nfunc _initialize():\n\tvar scene = load("res://main.tscn")\n\tquit(ResourceSaver.save(scene, "res://main.scn"))\n')
    expect(run('--script', 'res://save.gd').status).toBe(0)
    await writeFile(join(project, 'project.godot'), config('res://main.scn'))
    expect(run('--script', prepare).status).toBe(0)
    await writeFile(join(project, 'Global.gd'), 'extends Node\nvar value: int = 5\n')
    await writeFile(join(project, 'main.gd'), 'extends Node2D\nfunc read_global() -> int:\n\treturn Global.value\n')
    await writeFile(join(project, 'autoload.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n')
    await writeFile(join(project, 'project.godot'), config('res://autoload.tscn') + '[autoload]\nGlobal="*res://Global.gd"\n')
    const autoload = run('--script', prepare)
    expect(autoload.status, autoload.stderr).toBe(0)
    expect(autoload.stderr).not.toContain('not declared')
    await writeFile(join(project, 'project.godot'), config('res://absent.tscn'))
    const invalid = run('--script', prepare)
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('res://absent.tscn')
    expect(invalid.stderr).toContain('PackedScene')
  } finally { await rm(project, { recursive: true, force: true }) }
}, 20000)
