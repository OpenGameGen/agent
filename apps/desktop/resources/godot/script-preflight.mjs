/** Conservative guard for explicit node-script entrypoints, without running project code twice. */
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const nonMainLoop = new Set(['Object', 'RefCounted', 'Resource', 'Node', 'Node2D', 'Node3D', 'CanvasItem', 'CanvasLayer', 'Control', 'Area2D', 'Area3D', 'CharacterBody2D', 'CharacterBody3D', 'RigidBody2D', 'RigidBody3D', 'EditorScript'])

export async function preflightHeadlessScript(args) {
  const separator = args.findIndex(arg => arg === '--' || arg === '++')
  const flags = args.slice(0, separator < 0 ? undefined : separator)
  if (flags.includes('--check-only') || flags.includes('--help') || flags.includes('-h') || flags.includes('--version')) return 0
  const headless = flags.includes('--headless') || flags.some((arg, index) => arg === '--display-driver' && flags[index + 1] === 'headless')
  if (!headless) return 0
  let script
  let hasScript = false
  let project = process.cwd()
  let opaqueProject = false
  for (let index = 0; index < flags.length; index += 1) {
    const arg = flags[index]
    if (arg === '-s' || arg === '--script') { hasScript = true; script = flags[++index] }
    else if (arg === '--path' && flags[index + 1] !== undefined) project = resolve(flags[++index])
    else if (arg === '--main-pack' || arg === '--upwards' || arg === '-u') opaqueProject = true
    else if (arg.endsWith('project.godot')) project = dirname(resolve(arg))
  }
  if (!hasScript) return 0
  if (script === undefined || script.startsWith('-')) {
    console.error('Godot: --script/-s needs a script path, not another flag. Use godot-project check <project> to validate node scripts.')
    return 1
  }
  if (opaqueProject) return 0
  const path = script.startsWith('res://') ? join(project, script.slice(6)) : isAbsolute(script) ? script : join(project, script)
  let source
  try { source = await readFile(path, 'utf8') } catch { return 0 }
  // Only recognize a simple declaration at the start of the script. Stop on
  // strings, custom inheritance or any unfamiliar syntax; never scan bodies.
  for (const raw of source.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || /^@tool\s*(?:#.*)?$/u.test(line) || /^class_name\s+[A-Za-z_]\w*\s*(?:#.*)?$/u.test(line)) continue
    const match = /^extends\s+([A-Za-z_]\w*)\s*(?:#.*)?$/u.exec(line)
    if (match === null || !nonMainLoop.has(match[1])) return 0
    console.error(`Godot: headless --script/-s requires a MainLoop or SceneTree entrypoint; ${JSON.stringify(script)} directly declares non-MainLoop base class ${match[1]}. Use godot-project check <project> to validate node scripts, or godot-project run <project> --headless --quit-after 60 to run the main scene. No project code was run by this guard.`)
    return 1
  }
  return 0
}
