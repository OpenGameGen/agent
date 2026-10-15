import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
const engine = '/Applications/Godot.app/Contents/MacOS/Godot'
const available = process.platform === 'darwin' && spawnSync(engine, ['--version']).status === 0

it.skipIf(!available)('checks global and non-global autoloads, diagnoses missing global marker, and still rejects unused broken scripts', async () => {
  const project = await mkdtemp(join(tmpdir(), 'godot-autoload-check-'))
  const cli = new URL('../resources/godot/cli.mjs', import.meta.url).href
  const runner = `import { projectCommand } from ${JSON.stringify(cli)}; process.exitCode = await projectCommand(['check',process.argv[1]], { ensureEngine: async () => ${JSON.stringify(engine)} });`
  const check = () => spawnSync(process.execPath, ['--input-type=module', '-e', runner, project], { encoding: 'utf8', timeout: 30000 })
  const config = (prefix: string) => `config_version=5\n[application]\nconfig/name="AutoloadCheck"\nrun/main_scene="res://Main.tscn"\n[autoload]\nManager="${prefix}res://Manager.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`
  try {
    await writeFile(join(project, 'Manager.gd'), 'extends Node\nvar score: int = 7\nfunc _ready():\n\tprint("AUTOLOAD_STARTED_ONCE")\n')
    await writeFile(join(project, 'Main.gd'), 'extends Node\nfunc _ready():\n\tprint("MAIN_MUST_NOT_RUN", Manager.score)\n')
    await writeFile(join(project, 'Main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Main.gd" id="1"]\n[node name="Main" type="Node"]\nscript=ExtResource("1")\n')
    await writeFile(join(project, 'project.godot'), config('*'))
    const valid = check()
    expect(valid.status, valid.stdout + valid.stderr).toBe(0)
    expect(valid.stdout).toContain('OPENGAME_PROJECT_CHECK_COMPLETE')
    expect(valid.stdout).not.toContain('MAIN_MUST_NOT_RUN')
    expect(valid.stdout.split('AUTOLOAD_STARTED_ONCE')).toHaveLength(2)
    expect(valid.stderr).not.toContain('Godot hint:')
    await writeFile(join(project, 'project.godot'), config(''))
    const missing = check()
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('Identifier "Manager" not declared')
    expect(missing.stderr).toContain('use Manager="*res://Manager.gd"')
    await writeFile(join(project, 'Main.gd'), 'extends Node\nfunc _ready():\n\tprint(get_node("/root/Manager").score)\n')
    const nonglobal = check()
    expect(nonglobal.status, nonglobal.stdout + nonglobal.stderr).toBe(0)
    expect(nonglobal.stderr).not.toContain('Godot hint:')
    await writeFile(join(project, 'unused.gd'), 'extends Node\nfunc broken(:\n')
    const broken = check()
    expect(broken.status).toBe(1)
    expect(broken.stderr).toContain('unused.gd')
    await writeFile(join(project, 'project.godot'), 'config_version=5\n[input]\nleft={"events":[Object(InputEventKey,{"physical_keycode":65})]}\n')
    const started = Date.now()
    const invalidConfig = check()
    expect(invalidConfig.status, invalidConfig.stdout + invalidConfig.stderr).toBe(1)
    expect(Date.now() - started).toBeLessThan(10000)
    expect(invalidConfig.stderr).toContain('project.godot parsing failed')
    expect(invalidConfig.stderr).toContain('Expected property name as string')
  } finally { await rm(project, { recursive: true, force: true }) }
}, 60_000)
