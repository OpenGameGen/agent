import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
const engine = '/Applications/Godot.app/Contents/MacOS/Godot'
const available = process.platform === 'darwin' && spawnSync(engine, ['--version']).status === 0

it.skipIf(!available)('guards explicit headless node scripts through raw and project entrypoints without changing user arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-mainloop-check-'))
  const project = join(root, 'project')
  const cli = fileURLToPath(new URL('../resources/godot/cli.mjs', import.meta.url))
  try {
    await mkdir(project)
    await mkdir(join(root, 'engine'))
    await symlink('/Applications/Godot.app', join(root, 'engine', 'Godot.app'))
    await writeFile(join(root, 'engine', 'installed.json'), '{}')
    await writeFile(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="MainLoopCheck"\nrun/main_scene="res://Main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    await writeFile(join(project, 'node.gd'), 'extends Node2D\n')
    await writeFile(join(project, 'tree.gd'), 'extends SceneTree\nfunc _initialize():\n\tprint("TARGET_RAN",OS.get_cmdline_user_args())\n\tquit()\n')
    await writeFile(join(project, 'loop.gd'), 'extends MainLoop\nfunc _initialize(): print("TARGET_RAN")\nfunc _process(_delta): return true\n')
    await writeFile(join(project, 'comments.gd'), '# extends Node2D\nextends SceneTree\nconst TEXT = \"\"\"\nextends Node2D\n\"\"\"\nfunc _initialize():\n\tprint(\"TARGET_RAN\")\n\tquit()\n')
    await writeFile(join(project, 'derived.gd'), 'extends "res://tree.gd"\n')
    await writeFile(join(project, 'main.gd'), 'extends Node\nfunc _ready():\n\tprint("MAIN_RAN")\n\tget_tree().quit()\n')
    await writeFile(join(project, 'Main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript=ExtResource("1")\n')
    const run = (mode: 'engine' | 'project', args: string[]) => spawnSync(process.execPath, [cli, '--runtime', root, '--python', 'python3', '--mode', mode, ...mode === 'project' ? ['run', project] : ['--path', project], ...args], { encoding: 'utf8', cwd: project, timeout: 15000 })
    for (const mode of ['engine', 'project'] as const) {
      const bad = run(mode, ['--headless', '--quit-after', '2', '-s', 'res://node.gd'])
      expect(bad.status, bad.stdout + bad.stderr).toBe(1)
      expect(bad.stderr).toContain('base class Node2D')
      for (const file of ['tree.gd', 'loop.gd', 'derived.gd', 'comments.gd']) {
        const good = run(mode, ['--display-driver', 'headless', '--script', `res://${file}`])
        expect(good.status, good.stdout + good.stderr).toBe(0)
        expect(good.stdout).not.toContain('OPENGAME_MAINLOOP_CHECK_COMPLETE')
        expect(good.stdout.match(/TARGET_RAN/gu)).toHaveLength(1)
      }
      const forwarded = run(mode, ['--headless', '-s', 'res://tree.gd', '--', '-s', 'res://node.gd'])
      expect(forwarded.status, forwarded.stdout + forwarded.stderr).toBe(0)
      expect(forwarded.stdout).toContain('res://node.gd')
      const parse = run(mode, ['--headless', '--check-only', '-s', 'res://node.gd'])
      expect(parse.status, parse.stdout + parse.stderr).toBe(0)
      expect(parse.stdout).not.toContain('OPENGAME_MAINLOOP_CHECK_COMPLETE')
      const user = run(mode, ['--headless', '--quit-after', '2', '--', '-s', 'res://node.gd'])
      expect(user.status, user.stdout + user.stderr).toBe(0)
      expect(user.stdout).toContain('MAIN_RAN')
      expect(user.stdout).not.toContain('OPENGAME_MAINLOOP_CHECK_COMPLETE')
      for (const suffix of [[], ['--quit-after', '1']]) {
        const missing = run(mode, ['--headless', '--script', ...suffix])
        expect(missing.status).toBe(1)
        expect(missing.stderr).toContain('needs a script path')
      }
    }
    await writeFile(join(project, 'project.godot'), (await readFile(join(project, 'project.godot'), 'utf8')) + '\n[autoload]\nCounter="*res://counter.gd"\n')
    // Append one byte per initialization; the former dynamic preflight doubled it.
    await writeFile(join(project, 'counter.gd'), 'extends Node\nfunc _ready():\n\tvar old=FileAccess.get_file_as_string("res://count.txt") if FileAccess.file_exists("res://count.txt") else ""\n\tvar f=FileAccess.open("res://count.txt",FileAccess.WRITE)\n\tf.store_string(old+"x")\n')
    for (const mode of ['engine', 'project'] as const) {
      await writeFile(join(project, 'count.txt'), '')
      const once = run(mode, ['--headless', '-s', 'res://tree.gd'])
      expect(once.status, once.stdout + once.stderr).toBe(0)
      expect(await readFile(join(project, 'count.txt'), 'utf8')).toBe('x')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
