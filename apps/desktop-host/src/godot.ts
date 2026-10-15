/** Product Godot workflow skill, using the ordinary confined shell and terminal tools. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, join } from 'node:path'
import { observeGodotPreparation } from './godot-progress.ts'
import { registerGodotTools } from './godot-tools.ts'
import type { WorkerConfig } from './godot-worker.ts'

/** Application-owned plugin identity. */
export const name = 'desktop-godot'
/** The shared skill registry advertises and logs skill content through existing surfaces. */
export const inject = ['skills', 'tools', 'subprocess', 'sandbox', 'sandboxPolicy', 'systemPrompt']

/** Trusted Desktop-owned locations; callers cannot supply a command or download URL. */
export interface Config {
  readonly worker: WorkerConfig
  readonly root: string
  readonly resources: string
  readonly primaryRuntime: string
}

/**
 * Register the managed Godot workflow without introducing an unconfined execution tool.
 * @param ctx - Desktop profile scope with the normal skill registry.
 * @param config - Bundled installer resources and private runtime location.
 */
export function apply(ctx: Context, config: Config): void {
  for (const path of [config.root, config.resources, config.primaryRuntime]) {
    if (!isAbsolute(path)) throw new Error('Godot plugin requires absolute runtime paths')
  }
  const windows = process.platform === 'win32'
  const node = join(config.primaryRuntime, 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node')
  const python = join(config.primaryRuntime, 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']))
  ctx.systemPrompt.section({ name: 'product-godot-generation', order: 100,
    text: `You are a Godot game generation agent. Deliver a playable Godot 4.6 GDScript game and evidence of its main loop. Preserve the Harness workspace, permission and cancellation rules.

Load godot-game-development and inspect the project before editing. Preserve user work. For a new game, implement one small playable loop first: visible player, one input, one objective, feedback and restart. Default to simple 2D when the user does not specify a dimension; honor an explicit 3D request with a minimal 3D prototype. Add polish and extra systems only after the loop works. Use short focused scripts and small tested edits rather than a giant first script. For a new project, prefer godot_project_create with an empty workspace subdirectory and dimension="2d" or "3d"; never recreate an existing project, and use manual setup when the user requires a specific structure. The starter is only a skeleton: implement the requested gameplay and complete its verification. Prefer built-in ui_left/ui_right/ui_accept actions for the first playable loop; no InputMap configuration is needed. project.godot is ConfigFile data, not GDScript: do not put Key.LEFT or KEY_LEFT expressions in it. For a global autoload named GameManager, use [autoload] followed by GameManager="*res://scripts/GameManager.gd"; the leading * enables global access, otherwise use the /root/GameManager node explicitly. Call load_godot_runtime before engine operations. Use the managed engine; no GUI editor, native game window, Godot editor plugin or MCP server.

Use file tools for scripts/settings and native Godot tools for scenes, nodes and resources. Inspect before changing existing objects. Use small edits; godot_edit_batch groups 1–16 supported scene/node/resource operations atomically (32 KiB input). Attach a valid .gd with godot_node_reference(property="script"). Native node paths are root or Player/Camera2D, not runtime /root paths. Property values are one Godot literal; vector components must be numbers. Create references and parent directories first. Do not send whole-scene JSON. Scene tree script=null means no attached script; verify required bindings. Single native edits save automatically. For a related group call godot_edit_transaction begin once, native edits, then commit promptly; rollback cancels the group and undo reverts the latest committed group while the same worker lives. File-tool edits are outside this group.

Reuse the Headless worker across edits. Structured native errors are recoverable: read the error, inspect the affected object and fix the input. A failed edit inside a group reports whether it rolled back. After cancellation, timeout or crash, inspect disk before retrying; never assume an interrupted write was undone. Commit or rollback before stopping the worker or changing project.godot/autoload setup. Call godot_worker_stop after native editing.

Validate a milestone with godot-project check and a bounded Headless smoke; fix the first reported parser/runtime error before adding features. For browser tools, prepare load_godot_runtime(export_templates=true), call game_start with the absolute project directory, then game_tree to discover actual runtime paths. Use game_tree/game_state to locate the player and target, then measure displacement with a short key press before estimating further short inputs. If several inputs produce no progress, inspect input bindings, collisions, signals and attached scripts instead of repeating long blind movement. Assert each gameplay objective with game_assert; input delivery alone is not success. Its expected argument is a JSON literal string. In a game_test YAML file, assert.expected instead uses native values (expected: 3, expected: true, expected: menu), without JSON encoding; key: ArrowRight and duration_ms: 200 belong at the same indentation in one step, not inside a nested key object. Inspect game_errors and capture game_screenshot after meaningful behavior. Follow product-game-validation for repeated steps and recordings. A delivered input, screenshot or clean parser result alone is not a passed game test. Native/file edits save to disk, not the active preview. After edits, call game_start to rebuild/restart before testing; this is not state-preserving hot reload. Builds operate on a copy; do not edit it or invent a Web export preset.

Fix observed failures and repeat the relevant check. For delivery, leave the final playable browser preview open for the user; use game_stop for discarded runs or when finished with the preview. Report controls, objective/restart, entry scene, checks actually performed and concrete remaining blockers. Distinguish Headless, browser and target-platform evidence; exports alone do not prove Windows/macOS execution.`,
  })
  registerGodotTools(ctx, { root: config.root, resources: config.resources, node, python }, config.worker)
  ctx.tools.register(defineTool({
    name: 'load_godot_runtime',
    description: 'Prepare the desktop-managed Godot 4.6 standard engine without executing project code. Set export_templates=true before executable exports. Downloads are pinned and verified. Use the normal shell or terminal tools for Godot project operations after preparation; do not request wider workspace permissions just to install the engine.',
    parameters: { export_templates: { type: 'boolean', description: 'Install matching export templates as well as the engine; defaults to false.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        version: { type: 'string', required: true },
        commandDirectory: { type: 'string', required: true },
        bundledFontPath: { type: 'string', required: true },
        bundledFontLicensePath: { type: 'string', required: true },
        bundledFontMetadataPath: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 35 * 60 * 1000,
    async execute(args, exec) {
      const cancellation = new AbortController()
      const signal = AbortSignal.any([exec.signal, cancellation.signal])
      const handle = ctx.subprocess.spawn({
        argv: [node, '--use-env-proxy', join(config.resources, 'cli.mjs'), '--runtime', config.root,
          '--python', python, '--mode', 'project', 'install', ...(args.export_templates === true ? ['--templates'] : [])],
        cwd: config.resources,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
        graceMs: 3000,
        signal,
      })
      const finishProgress = observeGodotPreparation(handle, ctx.get('jobs'), exec.agent?.id, () => { cancellation.abort() })
      let status: 'completed' | 'failed' | 'killed' = 'failed'
      try {
        const outcome = await handle.done
        signal.throwIfAborted()
        if (outcome.exitCode !== 0) throw new Error(`Godot preparation failed (${String(outcome.signal ?? outcome.exitCode)}): ${handle.collected.stderr?.readFrom(0).text ?? ''}`)
        status = 'completed'
        return { version: '4.6.stable', commandDirectory: join(config.root, 'bin'),
          bundledFontPath: join(config.resources, 'fonts', 'NotoSansSC-VariableFont_wght.ttf'),
          bundledFontLicensePath: join(config.resources, 'fonts', 'OFL.txt'),
          bundledFontMetadataPath: join(config.resources, 'fonts', 'metadata.json') }
      } finally {
        try { handle.terminate(); await handle.waitForExit() }
        finally { finishProgress({ status: signal.aborted ? 'killed' : status }) }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Prepare Godot 4.6', kind: 'fetch' }),
  }))
  ctx.skills.register({
    name: 'godot-game-development',
    description: 'Generate Godot 4.6 GDScript games with built-in native resource tools and Headless checks; no editor window, Godot plugin or MCP required.',
    source: 'bundled',
    content: `# Godot 4.6 game development

The desktop supplies godot, godot4 and godot-project in local terminal/shell PATH. Call load_godot_runtime first; export_templates=true also prepares Web/executable export templates. Never ask the user to install Godot manually. Use the normal confined shell for project commands. godot_* and game_* names are agent tools, not shell commands; invoke them as tools. In the shell, use the supplied godot/godot4/godot-project CLI commands. Do not invoke the engine executable under engine/ directly: managed launchers isolate writable user data for the sandbox. If a launcher is missing or user://logs fails, call load_godot_runtime again and retry the supplied command; do not delete runtime/session directories or change sandbox permissions. No GUI editor, native game window, Godot editor plugin or MCP server during generation. Remote SSH machines need their own environment.

For Chinese Web UI, load_godot_runtime returns bundled Noto Sans SC variable font and OFL license paths. Copy both into the project. Use a font-only Node Autoload whose _enter_tree loads the FontFile and assigns ThemeDB.get_default_theme().default_font; do not preload it or set project.godot [gui] theme/custom before cold import. This keeps clean-checkout and Web build imports valid. New godot_project_create starters already include the font, Theme and a font-only Autoload that applies it after asset import; preserve these when editing project settings. Do not rely on host system fonts; inspect exported text glyphs and readable font size before declaring localized UI complete. Keep the font copyright/license with redistributed projects.

Start with one small playable loop: visible player, one input, objective, feedback and restart. Prefer simple 2D unless the user requests 3D. For a new project, prefer godot_project_create with an empty workspace subdirectory and dimension="2d" or "3d"; never recreate an existing project, and use manual setup when the user requires a specific structure. The starter is only a skeleton: implement the requested gameplay and complete its verification. Use short focused scripts; validate the first loop before adding polish or extra systems.

For simple controls use Input.get_axis("ui_left", "ui_right") and Input.is_action_just_pressed("ui_accept") in GDScript; these built-in actions already exist. Avoid editing InputMap unless custom controls are needed. project.godot is ConfigFile data, not GDScript: Key.LEFT/KEY_LEFT expressions are invalid there. A custom action must contain both deadzone and an events array of InputEvent objects, not just a key number. This minimal project.godot example binds physical A (65); merge into the existing [input] section rather than duplicating it:
\`\`\`ini
[input]
move_left={"deadzone":0.5,"events":[Object(InputEventKey,"physical_keycode":65)]}
\`\`\`
For a global autoload, add [autoload] and GameManager="*res://scripts/GameManager.gd". The leading * enables the GameManager global identifier; without it the autoload is only a node accessible as /root/GameManager. Do not add class_name GameManager to the same singleton script.

Then use Input.get_action_strength("move_left") in GDScript and run godot-project check. An action entry without events is invalid.

Commands (quote paths and preset names):
- godot-project status: inspect installed paths without downloading.
- godot-project check "<project>": import assets and load every project-local .gd for validation; initializes autoloads but does not instantiate the main scene. Run without piping to head/grep, which can hide the original error/exit status; fix the first error before expanding the game.
- godot-project run "<project>" --headless --quit-after 60: bounded runtime smoke; runtime errors return nonzero. This does not prove scripts are attached or gameplay works. Do not run a Node/Node2D gameplay script with -s/--script; that entrypoint requires MainLoop/SceneTree. Use check to validate scripts and run the assigned main scene to test gameplay.
- godot-project export "<project>" "<preset>" "<output>": native release export using an existing export_presets.cfg preset. --debug makes a debug export; --pack makes PCK/ZIP resources, not an executable.

Use file tools for scripts/settings and native tools for scene/resource edits. godot_scene_create creates one root; godot_node_add adds one built-in node. godot_scene_inspect reads the disk tree; view=properties or cells requires node. Editing paths use root or Player/Camera2D. godot_node_set changes one property; godot_node_reference binds an existing resource or, with property="script", a valid .gd with a matching base class. Write the script first. Example: godot_node_reference(project=PROJECT, path="res://Main.tscn", node="Player", property="script", reference="res://Player.gd"); inspect the tree to confirm Player.script. godot_node_edit handles rename/remove/reparent/duplicate/groups/signals. Inspect before editing existing objects.

Create/inspect/set/reference .tres files with godot_resource_*; values are one Godot literal such as Vector2(1, 2), Color(1, 0, 0, 1), true or a quoted string. Vector components must be finite numbers; integer vectors need whole numbers. For a collision shape: godot_resource_create(path="res://Shape.tres", type="CircleShape2D"), godot_resource_set(path="res://Shape.tres", property="radius", value="8"), then godot_node_reference(path="res://Main.tscn", node="Player/CollisionShape2D", property="shape", reference="res://Shape.tres"); pass the same project to each. Do not invent SubResource IDs in node_set. References and parent directories must exist; import textures with godot-project check. subresource uses a colon-separated property chain. Use domain tools for Theme, Curve, Gradient, animation tracks/keys and tiles. Build an Animation resource before godot_animation_bind. godot_tileset_create fills an atlas; godot_tile_cell edits one TileMapLayer cell, source=-1 erases it. Do not put whole-scene or batch JSON in individual value fields; use godot_edit_batch operations for supported batches.

For 1–16 related create/add/set/reference edits use godot_edit_batch with ordered operation objects (32 KiB input). It commits as one undo group or rolls back a normal failure, reports zero-based failed_index and per-step results, and refuses an open transaction. Single native calls already save without a transaction. To group other native operations: godot_edit_transaction begin once, small calls, then commit promptly. If an error reports rollback completed, the group is closed; fix the input rather than rolling back again. A commit with files=[] tracked no native edits and does not cover generic write/bash changes. rollback restores an open group; undo restores the latest committed group. Native failures attempt rollback and report its result; external-change conflicts are preserved. Only native target files are tracked (16 MiB original data), excluding file-tool writes. History expires with the worker, including after 60 seconds idle. Commit/rollback before checks, long planning, worker_stop or changing project settings/autoloads. Cancellation, timeout, crash or plugin teardown does not guarantee rollback: inspect disk before retrying. Structured rejections keep the worker available for corrections. Consecutive calls reload disk resources and reuse the worker; stop it when native editing ends.

Browser delivery: prepare templates, check, Headless smoke, game_start(project), game_tree(), game_state, meaningful input, game_assert, game_errors, game_screenshot. game_start generates its Web preset in a private copy; do not edit that copy or invent a source Web preset. Use absolute runtime paths returned by game_tree, e.g. /root/Main/Player, rather than native editing paths. game_assert expected is text containing one JSON literal: "3" or "true"; string values include their JSON quotes. Use tree/state to locate the player and target; compare coordinates before/after a short key press to estimate further short inputs. After several inputs without progress, inspect bindings, collisions, signals and script attachments rather than repeat long blind movement. Assert every gameplay objective, and inspect screenshots for visual problems when the model supports images. Do not claim visual inspection otherwise. Use game_test for ordered steps. Its YAML assert.expected uses native values (expected: 3, expected: true, expected: menu), not the JSON-encoded text required by game_assert. In each YAML input step, key: ArrowRight and duration_ms: 200 are sibling fields, not a nested key object; use the valid YAML example in the game_test description. Record/replay does not restore state or record manual input/delays; unchanged game_start preserves Autoloads, so reset state before replay. Frame stepping is not deterministic physics. Leave the final preview open with controls/objective/restart explained; game_stop closes it and discards its cache.

Report actual evidence. Parsing, Headless execution, browser behavior, exports and target-platform runs are different checks. C# needs .NET; mobile export needs SDKs/signing. Neither a screenshot nor delivered input alone proves the gameplay goal.
`,
  })
}
