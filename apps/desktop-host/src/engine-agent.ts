/** Product engine policy mounted inside a public Agent preset scope. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-skill'
export const name = 'product-engine-agent'
export const inject = ['tools', 'systemPrompt', 'skills']
export interface Config { engine: 'threejs' | 'godot' | 'general' }
export const THREE_GUIDANCE = 'Apply this guide only to a Three.js task. Build playable browser games with Three.js and JavaScript. Use threejs_project_create for a new empty project; otherwise inspect the existing project first. Use load_workspace_dependencies to obtain the managed Node.js and pnpm runtime when needed. Install project-local dependencies with pnpm, run pnpm build and call webgame_start(directory=<project>/dist) to preview in the desktop right panel. Use webgame_freeze before screenshot/state planning and webgame_thaw before gameplay inputs (the pause covers requestAnimationFrame clocks, not timers/Date.now/network). Use webgame_key/click/state/errors/screenshot, and webgame_test to batch restart/input/assertions without model delays, then read_image to inspect screenshots. These are your browser validation tools; do not assume other browser tools exist. Do not use Godot tools or install Godot for a Three.js task. Implement the requested gameplay, controls, objective, loss/win state and restart; a rendered scene alone is not a game. Use an animation loop with delta-time movement, resize the camera/renderer, cap device pixel ratio and dispose unused GPU resources. Use local npm dependencies, not remote CDN imports. Keep the scaffold\'s window.__game state observable (or provide equivalent deterministic state inspection) for gameplay tests. Run pnpm build. In the real browser, check console errors, perform start/movement/objective/restart interactions, inspect gameplay state and capture a final screenshot. If browser interaction or GPU rendering is unavailable, report that limitation and do not claim gameplay verification. Leave the playable preview available and report its URL, controls, objective and the checks actually performed. Use image-generation tools when assets help, and preserve attribution/licensing. Work in the selected workspace; do not change the selected engine or model.'
export const GENERAL_GUIDANCE = 'You are the upstream general-purpose coding agent with game-development capabilities across engines. Inspect the existing project before choosing technology: honor the user-selected engine and existing project files (package.json, project.godot, Unity Assets/Packages/ProjectSettings, Unreal .uproject, or other engine manifests). Do not replace an existing engine merely to use a convenient tool. For a new game with no engine preference, Three.js is the lightweight browser-game default; explain the choice, and ask only when requirements materially depend on the engine. Load threejs-game-development only for Three.js work, unity-game-development only for Unity work, and godot-game-development only for Godot work. Keep ordinary coding and non-game requests fully supported. Use engine-specific tools only after selecting that engine; Three.js creation and webgame previews are available, and Godot tools remain available for Godot projects. For other engines use ordinary file and shell tools plus available project documentation; do not pretend Unity-specific tools or engine installations exist. Check the actual local editor/compiler before attempting engine builds or play mode. Never claim browser previews validate a native Unity/Unreal build or claim gameplay verification from code generation alone. Preserve project engine/version, dependencies, user files and model selection.'
export const UNITY_GUIDANCE = 'Use this guide only when the user requests Unity or the existing project is Unity. Inspect ProjectSettings/ProjectVersion.txt, Packages/manifest.json, assembly definitions and existing Assets before editing; preserve the existing Unity version, rendering pipeline, input system and project structure. Implement gameplay with appropriate C# components, scenes and prefabs, and follow the existing project conventions. Preserve .meta files and GUID references; do not fabricate scene/prefab GUIDs or overwrite existing serialized assets. Prefer an installed Unity Editor and existing editor scripts to create or update serialized scenes/assets. For a new project, identify the requested/installed Editor version and create a valid project with that Editor; if unavailable, provide clearly scoped source/scripts and explain that a runnable Unity project has not been verified. Use ordinary file/shell tools; no Unity-specific product tool is currently installed. Determine the actual Editor executable and project settings before invoking documented batchmode compilation, tests or builds, inspect logs and exit status, and do not install or change engine versions without a user requirement. Unity WebGL output can use webgame preview tools only after a real successful WebGL export; browser checks do not prove native-platform behavior. Implement controls, objectives, win/loss and restart where required; report build/runtime limitations honestly.'
/** Scoped shadows suppress product Godot instructions without modifying core prompts. */
export function apply(ctx: Context, config: Config): void {
  if (!['threejs', 'godot', 'general'].includes(config.engine)) throw new Error('Unknown engine')
  if (config.engine !== 'godot') {
    for (const section of ['product-godot-generation', 'product-game-validation', 'product-game-tool-groups']) {
      ctx.effect(() => ctx.systemPrompt.section({ name: section, order: 100, text: '' }))
    }
  }
  if (config.engine === 'threejs') ctx.effect(() => ctx.skills.register({
    name: 'godot-game-development', source: 'bundled', description: 'Godot-only capability', content: '',
    invocation: { modelInvocable: false, userInvocable: false },
  }))
  if (config.engine !== 'godot') ctx.effect(() => ctx.skills.register({
    name: 'threejs-game-development', source: 'bundled', description: 'Build and validate Three.js browser games with local Node/pnpm and webgame tools.', content: THREE_GUIDANCE,
  }))
  if (config.engine === 'threejs') ctx.effect(() => ctx.systemPrompt.section({ name: 'product-threejs-development', order: 100, text: THREE_GUIDANCE }))
  if (config.engine === 'general') {
    ctx.effect(() => ctx.systemPrompt.section({ name: 'product-general-game-development', order: 100, text: GENERAL_GUIDANCE }))
    ctx.effect(() => ctx.skills.register({
      name: 'unity-game-development', source: 'bundled', description: 'Develop Unity games with existing project conventions, C# and an available local Unity Editor.', content: UNITY_GUIDANCE,
    }))
  }
  let release: (() => void) | undefined
  let signature = ''
  let updating = false
  const sync = () => {
    if (updating) return
    const deny = ctx.tools.schemas().map(tool => tool.name).filter((tool) => {
      if (config.engine === 'godot') return (tool.startsWith('threejs_') || tool.startsWith('webgame_'))
      if (config.engine === 'general') return false
      return tool.startsWith('godot_') || tool.startsWith('game_') || tool === 'load_godot_runtime'
    }).sort()
    const nextSignature=deny.join('\n')
    if(nextSignature===signature)return
    updating=true
    try { const next=ctx.tools.restrict({ deny }); release?.();release=next;signature=nextSignature }
    finally { updating=false }
  }
  sync()
  ctx.on('tools/change', sync)
  ctx.effect(() => () => release?.())
}
