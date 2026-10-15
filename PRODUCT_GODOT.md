# Managed Godot 4.6

English | [中文](PRODUCT_GODOT.zh.md)

## Summary

This product Desktop supplies `godot`, `godot4`, and `godot-project` in the PATH of newly created local terminals and agent shells. Users do not install Godot or edit their shell configuration. On first launch, Desktop prepares the pinned standard engine, Blender and export templates before opening the workspace. Subsequent launches and application reinstalls check versions and reuse healthy installations. Already installed complete templates for the same version are reused. Downloads require Internet access; installed resources work offline.

## Commands

Open the right sidebar, choose **New terminal**, then run:

```sh
godot --version
godot --help
godot-project status
godot-project install
godot-project install --templates
godot-project check "/path/to/project"
godot-project run "/path/to/project" --rendering-method gl_compatibility
godot-project editor "/path/to/project"
godot-project export "/path/to/project" "Windows Desktop" "build/game.exe"
godot-project export "/path/to/project" "macOS" "build/game.zip" --debug
godot-project export "/path/to/project" "Windows Desktop" "build/game.pck" --pack
```

The project needs `project.godot`; export needs the exact named preset in `export_presets.cfg`. Relative output paths resolve from the project directory. A Mac universal or ARM64 preset may require enabling ETC2/ASTC texture import in Project Settings. Project run and editor processes remain attached to the terminal; close their window or interrupt the command to stop them. Standard `godot` arguments pass through unchanged.

`check` imports assets and parses project-local GDScript, excluding symbolic links and caches. It returns a nonzero status for import, script, timeout, or engine errors, including errors that Godot logs while exiting zero. It does not prove runtime correctness. Use a real game run or `godot-project run "/path/to/project" --headless --quit-after 60` for a bounded runtime smoke. `godot-project run` returns nonzero for logged runtime errors even when Godot exits zero; the plain `godot` command preserves native exit behavior. A clean smoke does not prove scripts are attached or gameplay works. `--pack` creates a resource pack, not a standalone executable.

## AI workflow

The Desktop plugin registers `godot-game-development` and `load_godot_runtime`. The latter prepares only the pinned vendor payload, accepts only an optional `export_templates` boolean, and does not execute project code. Use it before confined shell operations so installation does not require widening project permissions. Project execution continues through existing shell and terminal tools; normal workspace permission checks still apply.

## Shortest first-game delivery

1. Build one small playable loop: visible player, one input, objective, feedback and restart. Default to simple 2D when unspecified; honor explicit 3D requests with a minimal 3D prototype. Verify the loop before adding polish and systems; keep scripts short.
2. Prepare the engine and create `project.godot`, a main scene and directories. Use small native scene/resource edits; write scripts with file tools and attach them. Use `godot_edit_batch` for 1–16 related create/add/set/reference edits; for other edits use `godot_edit_transaction(begin)` → small calls → `commit`.
3. Run `godot-project check`, then a bounded Headless smoke. Fix the first parser/runtime error before adding features.
4. Prepare templates, then `game_start(project)` → `game_tree()` for real runtime paths → initial state → input → `game_assert` for the expected change → `game_errors` → `game_screenshot`. The tool creates its Web preset in a copy; do not invent a source preset. Call `game_start` again after code changes.

Optional `game_assert` `timeout_ms` is an integer 0..10000, default 0 for an immediate check. A positive value samples state every 100ms without repeating input; YAML places it beside `assert`. Results distinguish immediate/eventual and retain first/last values, attempts, elapsed time and observation timestamps. Matching within the window does not establish immediate or sustained success, event latency or causation. Invalid paths, transport errors and cancellation cannot become success.
5. Stop the editing worker, leave the final sidebar preview open, and explain controls, objective and restart. `game_stop` closes the user's playable page; use it for discarded runs or finished previews. If the model cannot read images, report that visual inspection remains unverified rather than treating a screenshot file as proof.

| Parameter | Correct use |
|---|---|
| Native `project`, `game_start.project` | Absolute directory containing `project.godot` |
| Native editing `node` | `root` or `Player/Camera2D` |
| Runtime `node_path` | Read from `game_tree`, e.g. `/root/Main/Player` |
| Native `value` | One Godot literal, with numeric vector components |
| `game_assert.expected` | A string containing one JSON literal: `3`, `true`, or text with its JSON double quotes |

`godot_edit_transaction` rollback restores an open group; undo restores the latest committed group in the same worker. Normal native failures attempt rollback and report the result. Only native target files are tracked, with a 16 MiB original-data limit; file-tool edits are outside the group, and external modifications or changed symlinks are not overwritten. Finish groups before checks, long planning or stopping the worker. History expires at the 60-second idle limit, turn completion or stop. Cancellation, timeout, crashes and plugin teardown are not durable transactions; inspect disk before retrying.

## Storage and recovery

Launchers and engine live under `$DSH_HOME/dsh-runtimes/godot-4.6`; development uses its separate Harness home. Node and Python come from the bundled primary runtime. The signed Desktop installer carries the CLI resources outside ASAR, while downloaded executables stay outside the signed application. No global PATH entry or system Godot installation is changed. Export templates use Godot's documented per-user data directory, under `export_templates/4.6.stable`. The official template archive is approximately 1.2 GiB and expands to several GiB; it is downloaded only for executable exports or explicit template preparation.

New archives are streamed to temporary files, verified against locked SHA-256 and byte counts, safely extracted, and published after version checks. Failed downloads can be retried; no incomplete installation is reported ready. Concurrent installers share locks. A killed installer's dead-owner lock is reclaimed; an invalid lock or interrupted lock recovery reports the exact lock file to remove. Desktop preparation repairs incomplete or mismatched templates by staging a verified replacement and retaining the previous directory. Direct CLI calls report template damage unless repair is explicitly requested. Download timeout is controlled by `GODOT_DOWNLOAD_TIMEOUT_MS` (default 30 minutes).

## Scope and maintenance

Supported Desktop targets are macOS ARM64/x64 through the universal engine and Windows x64 through the console executable. Windows ARM64 is not a Desktop packaging target yet. Standard builds support GDScript; C# requires the .NET engine and SDK. Android and iOS exports require their platform SDKs and signing. SSH terminals run on another machine and need that machine's own Godot setup. An explicitly replaced PATH or shell command alias can override normal command resolution.

The isolated product files are `apps/desktop/resources/godot/`, `apps/desktop/src/product/godot-environment.ts`, and `apps/desktop-host/src/godot.ts`. Upstream integration is limited to Desktop Host environment preparation, plugin mounting, dependencies, and the resource-copy entry. For an engine upgrade, update `lock.json` from the official release digests, the versioned runtime root, binary names, tool output, skill instructions, and focused tests together. Validate native game startup, error detection, export, and newly created terminal PATH before merging.

## Sources

[Godot 4.6 release](https://godotengine.org/download/archive/4.6-stable/), [CLI reference](https://docs.godotengine.org/en/4.6/tutorials/editor/command_line_tutorial.html), and [data paths](https://docs.godotengine.org/en/4.6/tutorials/io/data_paths.html). The bundled `LICENSE.txt` carries Godot's MIT license; official binary archives retain their upstream resources.

## Built-in Headless game generation tools

The Desktop Agent follows a Godot 4.6 GDScript game generation workflow. Tools register directly through Cordis without Godot MCP or a project editor plugin, and generation does not automatically open an editor or game window. Ordinary file tools own `project.godot` and `.gd`; native scene/node tools or ordinary file tools edit `.tscn`, and native resource tools edit complex `.tres` resources one property, point, track, key, Theme item, or Tile at a time rather than accepting a whole-resource batch JSON.

Call `load_godot_runtime` first. Use `godot_resource_create/inspect/set/reference` for creation, inspection, stored properties, and resource links. Domain operations are `godot_curve_point`, `godot_gradient_point`, `godot_animation_track/key`, `godot_theme_item`, and `godot_tile_atlas/create`. Values are Godot literals such as `Vector2(1, 2)` or `Color(1, 0, 0, 1)`, not code. The engine checks types, reference classes, indices, ranges, and saves. Paths stay inside the project; parent directories must exist. Import textures through Headless `godot-project check` first. Edit external referenced resources through their own file paths; `subresource` uses colon-separated property chains to inspect references or edit embedded resources. `godot_node_reference(property="script")` attaches an existing compatible `.gd`; invalid syntax or base classes are rejected before saving. Vector components are checked for finite numbers and integer vectors reject fractions. Structured rejections keep the worker available for corrected inputs.

The first resource operation starts the application-owned `resource-worker.gd` with `--headless --script` and no `--editor`. Each Host keeps one worker: consecutive calls in the same task/project reuse it, while project, task, or sandbox-policy changes close the previous process. Each operation reloads the root and dependencies from disk with `CACHE_MODE_IGNORE_DEEP`; resource objects do not survive between calls. Call `godot_worker_stop` when finished. Turn completion, cancellation, deadlines, disposal, and idle expiry also clean up the process. A crash does not replay edits automatically; the next call starts a new worker. Inspect files before retrying a write whose outcome is unknown.

The worker uses existing subprocess and per-session sandbox services, including workspace restrictions and credential scrubbing. Godot logs live in a random private temporary directory inside the project, compatible with workspace confinement on each platform and removed on exit; tool scripts stay outside user projects. Native tools require `workspace-write`; use ordinary file reads under read-only permission. Desktop config explicitly sets a 60-second idle limit, a 30-second request deadline, and a 64 KiB request/response cap. Desktop resource copying ships the script, and startup checks detect missing files. This editing module provides small-step native scene, node and resource edits, with short-lived native edit groups, without screenshots, game input, editor bridges or arbitrary GDScript execution tools. Other product modules are documented separately.

Implementation lives in `apps/desktop-host/src/godot-tools.ts`, `godot-worker.ts`, and the application Godot resources; the upstream Agent loop is unchanged. Selected functions from [Vollkorn's pinned Headless editing source](https://github.com/Vollkorn-Games/godot-mcp/blob/632530638448ea3e79394fbf74e9a5c92c4b67e5/src/scripts/godot_operations.gd) are directly adapted in `vollkorn-edit.gd`. The original MCP server, CLI dispatcher and editor bridge are excluded. Source mapping, modifications and MIT attribution are described below.

## Vollkorn editing source alignment

The imported source is pinned at `632530638448ea3e79394fbf74e9a5c92c4b67e5`; `apps/desktop/resources/godot/vollkorn-source.json` records the source file digest, each selected function's line/digest, adaptations and product extensions. The runtime ships 28 selected editing/helper functions in `vollkorn-edit.gd` and the original MIT notice in `VOLLKORN_LICENSE.txt`. Five conversion, serialization and ownership helpers remain byte-for-byte unchanged and are checked against their imported digests.

| Built-in editing interface | Imported source functions |
|---|---|
| `godot_resource_create` | `create_resource` |
| `godot_scene_create`, `godot_scene_inspect` | `create_scene`, `get_scene_tree`, `get_node_properties`, `get_tile_data` |
| `godot_scene_instance` | `instantiate_scene`, `_set_owner_recursive` |
| `godot_node_add`, `godot_node_set/reference` | `add_node`, `set_node_properties`, `_convert_property_value` |
| `godot_node_edit` | `remove_node`, `rename_node`, `reparent_node`, `duplicate_node_op`, `add_to_group`, `remove_from_group`, `connect_signal_op` |
| `godot_animation_bind` | `add_animation` with a separately edited Animation resource |
| `godot_tileset_create`, `godot_tile_cell` | `create_tileset`, `set_cells` with one cell |

The upstream editing bodies are adapted to an operation-local module rather than copying the MCP server. Prints and one-shot process exits become structured results and early returns; allocated nodes are freed after each operation; all loads ignore root/dependency caches. Native save results and node property readback prevent reporting rejected edits as success. A root does not own itself, signal connections use `CONNECT_PERSIST`, and animation binding checks library existence before accessing it. SceneTree operations start on the first process frame, following upstream's autoload initialization order. Changing project settings or autoload setup requires `godot_worker_stop` before further editing.

Model inputs remain small: create a root, add one node, set one property, bind one resource, edit one node, or write one cell. Source operations that accept arrays receive internally constructed single-item values, not whole-resource JSON. `godot_edit_batch` explicitly composes the bounded operations listed below. Node paths use `root` or a relative descendant path. Engine type checks, duplicate-name checks, cycle rejection, project-path restrictions and no-overwrite creation are enforced before mutation. `view=properties` or `view=cells` on `godot_scene_inspect` requires a node path. Animation resources retain their edited duration/tracks when bound into the default library. The TileSet creation tool fills all whole tiles of one atlas, matching upstream.

Theme, Curve, Gradient, typed resource inspection, embedded-resource edits and manual atlas/single-tile tools remain product extensions: this pinned repository has no corresponding specialized Theme/Curve/Gradient editor functions. Existing script, settings and generic file-editing tools are not duplicated. Asset installation, mesh-library export, custom script-class creation, scene analysis, game testing, screenshots, game input and the editor bridge are not imported into this editing module.

For an upgrade, fetch the new explicit source commit, compare the 28 mapped functions, reapply only listed adaptations, and update the source digest/line/digest mapping and retained license. Run the real-engine scene/resource tests, verify the unchanged helper digests, then refresh/replay the Godot-only session fixture and check the Desktop resource-copy entry. Do not replace the pinned source silently or treat macOS tests as Windows installation evidence.

## Right-Sidebar game validation

The independent `desktop-game-validation` Cordis plugin registers built-in tools without an MCP server. Prepare `load_godot_runtime(export_templates=true)`, then call `game_start(project, scene?)`. A private copy of a Godot 4.6 GDScript project receives a Compatibility, single-threaded Web Debug preset, HTML shell, and test Autoload. Source configuration stays unchanged; no Godot editor plugin is installed. Headless processes import/export and the existing right-Sidebar Electron webview runs the result. Select the task before starting; later operations reveal the same game tab. Observation/input on other selected tasks, closed pages and navigation are refused; `game_start` can reopen a closed game page.

`game_screenshot` saves PNG evidence and returns a durable image attachment only when the active model route explicitly supports image input. Otherwise it returns the path and an explicit visual-unverified result; switch to a vision model and use `read_image` to inspect it. `game_key(key, duration_ms?)`, `game_click(x,y)`, and `game_click_ui(node_path)` use browser input and release held keys on cancellation. Keys are physical browser keys such as ArrowRight, w, Space or Enter, not InputMap action names such as ui_right; action names belong to game_reproduce actions_down/actions_up. `game_keys(keys, duration_ms?)` holds 1–8 physical keys together, then releases them; for example, `["w", "Space"]` moves forward while jumping. Duplicate keys or conflicting aliases are rejected before input; cancellation and failures attempt to release keys pressed by this call. YAML uses `keys: [w, Space]` with `duration_ms`; recording and replay retain the chord. Coordinate clicks use browser CSS pixels. UI targeting converts a Godot Control center; SubViewport UI targeting is explicitly unsupported. `game_tree(node_path?, depth?, limit?)` returns the live tree including non-UI nodes, script and scene paths; defaults are `/root`, depth 8 and 200 nodes. Explore a subtree when truncated. `game_ui`, `game_state(node_path, property?)`, `game_logs`, `game_errors`, and `game_metrics` return bounded observations; read stdout and errors separately. Repeated `game_start` hashes staged source content. Unchanged content switches/restarts the requested scene in the same page without launching Godot; scene Autoloads persist. Omitted scene restarts the initial entry scene. Changed content exports a fresh PCK, reuses the Web engine files, and starts a fresh page to invalidate resource/script caches. Failed builds retain the previous run. Engine or harness changes require a full export. The cache lasts until stop or lifecycle cleanup. After 30 minutes without tool activity, an open game is retained; closed, navigated or crashed instances are reclaimed. An uncertain lifecycle check retains the instance and retries. `game_stop` and plugin disposal close the page/server and remove staging. Evidence remains in project `.opengame-test-results/<run-id>/`.

`game_assert(node_path, property, operator, expected)` compares observed values; expected is one JSON literal. Subscribe with `game_watch_signal(node_path, signal)` before input, then pass its cursor to `game_wait_signal(node_path, signal, after)` (10-second limit). Signal occurrence is captured without arguments. `game_test(test_file)` reads project-local YAML with `name` and up to 100 `steps`: key plus duration_ms, click, click_ui, assert, wait_node, watch_signal followed by wait_signal, screenshot, wait_ms, freeze, thaw, step. Reports distinguish passed, failed, and incomplete. Delivery or an image alone never means success. `game_freeze/thaw/step` controls pausable SceneTree nodes. `game_step(frames, clock)` defaults to process frames; explicit `clock="physics"` advances exactly N pausable physics ticks including solver steps and returns paused. YAML uses `step: N` with `clock: physics`. Process callbacks may also run between ticks and ALWAYS nodes remain active; this is not global or cross-platform determinism. Cancellation attempts a separate pause request; the bridge also has a 10-second watchdog. A crashed page cannot confirm pause recovery.

`game_record(action="start"/"stop")` records successful tool actions as reviewable YAML; stop recording before restarting/stopping a run. `game_replay(test_file)` executes against current state, so restore the starting state first. Scene restarts preserve Autoloads and do not restore a full snapshot. Recordings omit manual user input and delays between model calls; replay without assertions or observed conditions is `unverified`. Ordered `game_test`/`game_replay` steps provide continuous input sequences.

`game_reproduce(test_file)` compares two isolated cold instances of the current build. Finish source and manifest edits before `game_start`; changed source/runtime requires rebuilding, and active recording prevents reproduction. Each trial uses a fresh in-memory browser partition. The project's `reset_node` must implement synchronous `_opengame_reset(seed)` returning `true` and restore its nodes, Autoloads, timers and random generators. A project-local YAML/JSON manifest, limited to 64 KiB, can be:

```yaml
version: 1
seed: 123
reset_node: /root/Main
observations:
  - node: /root/Main/Player
    property: position
steps:
  - actions_down: [ui_right]
    physics_ticks: 60
  - actions_up: [ui_right]
    physics_ticks: 1
```

Actions must exist in InputMap. Limits are 1–32 observations, 1–100 steps, 1–120 physics ticks per step and 1200 ticks total. Initial and post-step samples compare finite JSON values at full floating-point precision; oversized data is rejected rather than truncated into success. Results include `reproducibility_verified`, the first difference and a full report path. Equality covers only this build, seed and declared observations in two trials, not global or cross-platform determinism. The original preview remains; trial guests close and their exclusive storage is cleared. If a trial page navigates elsewhere, cleanup waits for that guest to close, preserving ordinary workspace browser data.

Implementation is in Desktop Host `game-validation.ts`, `game-build.ts`, `game-tests.ts`, and `game-transport.ts`; `apps/desktop/src/product/game-browser.ts` owns Electron control. Sidebar Browser exposes an optional `onGameOpen` callback. Private Desktop IPC carries fixed operations, not model-supplied JavaScript. Scripts and HTML ship with Godot resources. `game-sources.json` records pinned sources and adaptation scope; Runtime Control traversal retains MIT attribution, and Vollkorn supplies the subscribe-before-input design.

Test YAML is checked before browser interaction: signal waits need a preceding subscription for the same node and signal; ordered comparisons require finite numeric expectations; duration_ms belongs to keys and timeout_ms belongs to waits and assertions. Invalid tests send no clicks or keys.

## Game generation prompt

`apps/desktop-host/src/godot.ts` contributes an always-on game workflow through the public system prompt section API: build a minimal playable loop with short scripts, small native edits and short edit groups, distinguish editing/runtime paths, reuse the Headless worker, inspect uncertain writes before retrying, and stop the editing worker while leaving the final browser preview open. Validation distinguishes import/parser checks, Headless runtime, browser behavior and target-platform execution. Browser previews follow the game validation module. Existing workspace, permission and cancellation guidance remains intact. Loader snapshots cover the assembled section and session replay covers the model-visible prompt; neither proves autonomous game completion by a live model.

`godot_edit_batch(project, operations)` accepts 1–16 ordered objects, with a 32 KiB input limit. Supported operations are `scene_create`, `node_add`, `node_set`, `node_reference`, `resource_create`, `resource_set`, and `resource_reference`. Each uses the matching single tool’s fields without project; scripts, files, shell commands and nested transactions are excluded. All arguments and paths are validated before mutation. Normal edit failure restores batch target files and returns a zero-based failed_index, per-step results and not-run markers; check that rollback is completed. Success replaces the latest worker-local undo group, so undo restores the entire batch; failure preserves the preceding undo group. An open transaction causes rejection without changing it. The existing 16 MiB original-data limit, external-change conflicts and non-durable transaction boundaries apply. Every scene-tree node has a script field containing its attached resource path; null explicitly means no attached script.

The scene tree root includes `saved_connections` from the inspected scene file (source/signal/target/method, `.` means root), capped at 64 with `saved_connections_truncated=true` when needed. Runtime-only script connections are outside this disk summary. Native connect checks emitted argument counts against required/default/variadic method parameters and does not bind/unbind; callback behavior and dynamic types still require runtime verification.

### Global autoloads and checking boundaries

To use `GameManager` as a global identifier, add `[autoload]` and `GameManager="*res://scripts/GameManager.gd"` to `project.godot`. The leading `*` enables the singleton global. Without it, the autoload is a valid non-global node accessed as `/root/GameManager`. Do not also declare `class_name GameManager` in that singleton script.

After import, `godot-project check` loads every project-local GDScript after normal SceneTree initialization, including scripts not referenced by a scene. This initializes autoloads but does not itself instantiate the main scene or ordinary scripts. It is not a side-effect-free static check; normal project permissions still apply, with a 30-second script-check deadline. Read its original output without piping through `head/grep`, which can hide diagnostics and the exit status. Only when Godot actually reports an undeclared identifier matching a non-global autoload does the CLI append a precise `*` hint; it preserves the original error, changes no files, and allows valid non-global autoloads.

Headless `-s/--script` entrypoints must derive from `MainLoop`/`SceneTree`; they do not run ordinary `Node`/`Node2D` gameplay scripts. Managed raw `godot` and `godot-project run` conservatively reject explicit direct declarations of common non-MainLoop built-in classes at the start of a script, and diagnose missing paths. This prevents the observed Godot 4.6 macOS headless modal-alert misuse without running another engine or initializing autoloads twice. Custom inheritance, unfamiliar headers and opaque packed projects pass through unchanged; this is not complete inheritance validation or universal modal-alert prevention. `--check-only` and game arguments after `--`/`++` remain unchanged.

### Chinese Web fonts

`load_godot_runtime` returns absolute paths to the bundled, unmodified Noto Sans SC variable font, OFL license and source/hash metadata. For existing projects, copy the font and license into the project, use a font-only Node Autoload whose `_enter_tree` loads the font and assigns `ThemeDB.get_default_theme().default_font`. Avoid top-level preload or startup `[gui] theme/custom` references to an unimported font: Web build copies and clean checkouts import assets afresh. Do not rely on browser/host font fallback. Verify the actual text glyphs and readable size; this font is not a promise of complete Unicode coverage.

The `opengame:blank-project@2` starter includes the font, license, DefaultTheme.tres and a font-only OpenGameUIFont Autoload. It applies the default font at runtime after import, avoiding a first-import dependency error. Preserve this Autoload when editing settings. The byte-level SHA-256 manifest includes font/license files; corrupt bundled assets are rejected before project creation. Writes remain exclusive per file with partial files retained on failure, not crash-atomic. No gameplay is added.
