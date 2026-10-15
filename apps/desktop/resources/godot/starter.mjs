/** Application-owned, versioned blank projects. No gameplay or acceptance fixtures. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const source = 'opengame:blank-project@2'

/** Resolve a child directory without following project-side symlinks. Parent must exist. */
async function destination(workspace, input) {
  if (!isAbsolute(workspace) || !isAbsolute(input)) throw new Error('Workspace and project must be absolute paths')
  const suffix = relative(resolve(workspace), resolve(input))
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Choose a child project directory inside the workspace')
  const root = await realpath(workspace)
  const parts = suffix.split(sep)
  let path = root
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i])
    try {
      const entry = await lstat(path)
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Project path must contain only real directories, not symlinks or files')
    } catch (error) {
      if (error.code !== 'ENOENT' || i !== parts.length - 1) throw error
    }
  }
  return path
}

/** Deterministic basic visible scenes; gameplay intentionally remains to be implemented. */
export function template(dimension, title) {
  if (!['2d', '3d'].includes(dimension)) throw new Error('dimension must be 2d or 3d')
  if (typeof title !== 'string' || !title.trim() || title.length > 80 || /[\u0000-\u001f\u007f]/u.test(title)) throw new Error('title must be 1–80 characters without control characters')
  const project = `config_version=5\n\n[application]\nconfig/name=${JSON.stringify(title)}\nrun/main_scene="res://Main.tscn"\n\n[display]\nwindow/size/viewport_width=960\nwindow/size/viewport_height=540\nwindow/stretch/mode="canvas_items"\n\n[autoload]\nOpenGameUIFont="*res://OpenGameUIFont.gd"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.08, 0.1, 0.16, 1)\n`
  const script = `extends ${dimension === '2d' ? 'Node2D' : 'Node3D'}\n\n# OpenGame blank starter. Implement the requested gameplay here.\n# No player controls, objectives, score, win/lose conditions, or tests are provided.\nfunc _ready() -> void:\n\tpass\n`
  const scene = dimension === '2d' ? `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://Main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n\n[node name="Placeholder" type="Polygon2D" parent="."]\nposition = Vector2(480, 270)\npolygon = PackedVector2Array(-48, -48, 48, -48, 48, 48, -48, 48)\ncolor = Color(0.3, 0.65, 0.9, 1)\n` : `[gd_scene load_steps=4 format=3]\n\n[ext_resource type="Script" path="res://Main.gd" id="1"]\n\n[sub_resource type="BoxMesh" id="Box"]\n\n[sub_resource type="PlaneMesh" id="Ground"]\nsize = Vector2(8, 8)\n\n[node name="Main" type="Node3D"]\nscript = ExtResource("1")\n\n[node name="Placeholder" type="MeshInstance3D" parent="."]\nposition = Vector3(0, 0.5, 0)\nmesh = SubResource("Box")\n\n[node name="Ground" type="MeshInstance3D" parent="."]\nmesh = SubResource("Ground")\n\n[node name="Camera3D" type="Camera3D" parent="."]\nposition = Vector3(0, 4, 6)\nrotation = Vector3(-0.588003, 0, 0)\ncurrent = true\n\n[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]\nrotation = Vector3(-0.785398, -0.523599, 0)\nlight_energy = 1.2\n`
  const fontSetup = 'extends Node\n\nfunc _enter_tree() -> void:\n\tvar ui_theme = load("res://DefaultTheme.tres") as Theme\n\tThemeDB.get_default_theme().default_font = ui_theme.default_font\n'
  const theme = '[gd_resource type="Theme" load_steps=2 format=3]\n\n[ext_resource type="FontFile" path="res://NotoSansSC-VariableFont_wght.ttf" id="1"]\n\n[resource]\ndefault_font = ExtResource("1")\n'
  return { 'project.godot': project, 'Main.gd': script, 'Main.tscn': scene, 'OpenGameUIFont.gd': fontSetup, 'DefaultTheme.tres': theme }
}

/** Create exclusively, preserving partial files on failure for inspection. Not a durable transaction. */
export async function createProject({ workspace, project, dimension, title = 'Untitled Game' }) {
  const files = template(dimension, title)
  const metadata = JSON.parse(await readFile(new URL('./fonts/metadata.json', import.meta.url), 'utf8'))
  const font = await readFile(new URL('./fonts/NotoSansSC-VariableFont_wght.ttf', import.meta.url))
  const license = await readFile(new URL('./fonts/OFL.txt', import.meta.url))
  if (createHash('sha256').update(font).digest('hex') !== metadata.sha256
    || createHash('sha256').update(license).digest('hex') !== metadata.licenseSha256) throw new Error('Bundled font integrity check failed')
  files['NotoSansSC-VariableFont_wght.ttf'] = font
  files['NotoSansSC-OFL.txt'] = license
  const target = await destination(workspace, project)
  try { await mkdir(target) } catch (error) { if (error.code !== 'EEXIST') throw error }
  if ((await readdir(target)).length !== 0) throw new Error('Project directory must be empty; existing files will not be overwritten')
  const identity = await lstat(target)
  const lock = await open(join(target, '.opengame-starter-lock'), 'wx', 0o600)
  await lock.close()
  // A concurrent initializer sees the lock and fails. Every content file is exclusive.
  const manifest = { source, dimension, gameplay_implemented: false, main_scene: 'res://Main.tscn', files: Object.entries(files).map(([path, text]) => ({ path, sha256: createHash('sha256').update(text).digest('hex') })) }
  try {
    for (const [name, text] of [...Object.entries(files), ['opengame-starter.json', JSON.stringify(manifest, null, 2) + '\n']]) {
      const checked = await destination(workspace, project)
      const current = await lstat(checked)
      if (checked !== target || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Project directory changed during creation')
      const file = await open(join(target, name), 'wx', 0o600)
      try { await file.writeFile(text) } finally { await file.close() }
    }
  } catch (error) { throw new Error(`Starter creation incomplete at ${target}; preserve and inspect partial files before retrying. ${error.message}`) }
  await unlink(join(target, '.opengame-starter-lock'))
  return { project: target, ...manifest, manifest: 'opengame-starter.json', validation: { engine_check: 'not_run', runtime_smoke: 'not_run', gameplay: 'not_implemented' }, next_steps: [{ tool: 'load_godot_runtime' }, { command: 'godot-project', args: ['check', target] }, { command: 'godot-project', args: ['run', target, '--headless', '--quit-after', '60'] }], note: 'Basic visible skeleton only. Implement and test gameplay; this is not a playable game or a passed gameplay test. Creation is exclusive per file, not crash-atomic; concurrent external directory replacement is unsupported.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await createProject(JSON.parse(process.argv[2] ?? '{}')))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
