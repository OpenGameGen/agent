# Managed development environments

English | [中文](README.zh.md)

Desktop composes the product-owned `desktop-environments` Cordis plugin, resource CLI and launch-environment module through the existing `dsh` desktop profile. Node.js, Python and pnpm use the release-pinned primary-runtime payload. Blender 4.5.14 LTS and npm 11.6.2 download on demand through the manager or fixed tool with fixed sizes and SHA-256 digests. Godot 4.6 retains its installer, export templates and Headless tools; see [Godot](../../PRODUCT_GODOT.md). The implementation does not edit system PATH, shell startup files or the Agent core.

## Usage

The supported `terminal-controller` profile selects profile-free Bash on macOS or CMD with AutoRun disabled on Windows, preserving managed PATH ordering. Users can select other shells; their startup scripts may override PATH. Default local Desktop terminals and Agent shells inherit `agent-env`, `node`, `npm`, `npx`, `pnpm`, `python`, `python3`, `pip`, `pip3`, `blender` and the existing Godot commands. Desktop opens the workspace without probing or installing engines. The application menu provides Creation environments for on-demand inspection and preparation. The Agent checks status/doctor, then calls the fixed ensure operation for missing components; it must not choose arbitrary URLs or install system applications. The `manage_runtime_environment` tool accepts `status`, `doctor`, `ensure` and `repair`; the `managed-development-environments` skill explains project isolation. Remote SSH hosts have separate environments.

```sh
agent-env prepare-desktop
agent-env status
agent-env doctor all
agent-env ensure blender
agent-env repair blender
agent-env open blender
agent-env project "/path/to/existing/project" --python --node
```

Status reports installation facts. Doctor probes executable versions and basic capabilities without downloading. Open launches Blender's complete native interface; automated modeling uses ordinary shell execution of `blender --background --factory-startup --python script.py`. Version checks do not validate GUI, GPU rendering or target-machine compatibility.

## Storage and dependencies

The Harness home contains shared downloads, versioned Blender/npm directories, launchers and caches under `dsh-runtimes/environments/`. Interpreters remain in the application-owned primary-runtime and are shared by projects. Project preparation requires an existing directory, creates `.venv` and `.agent-environment.json`, records shipped Node/Python versions and preserves existing environments; conflicting recorded versions are rejected. This release does not download arbitrary interpreter versions or switch versions automatically. The metadata does not constrain unrelated package managers or enforce version selection for projects launched by other tools.

Run npm/pnpm in the project to keep dependencies in `node_modules`. Use `.venv/bin/python -m pip`, or `.venv\Scripts\python.exe -m pip` on Windows. The Python/pip launchers select `VIRTUAL_ENV` or the current directory's `.venv`; pip refuses installation without a virtual environment. Child processes receive private npm/pip caches. Only npm-launcher children receive the application-owned npm global prefix, avoiding interference with shell-level nvm. Blender's Python stays separate. Native dependencies without prebuilt packages may still need compilers and system libraries.

## Repair and delivery

Installations use cross-process locks, verified caches, staging directories and version checks before publication. Failed downloads or extraction do not publish a new installation and can be retried. A separate recovery lock reclaims dead installer locks. Blender/npm/Godot repair verifies a new directory before replacing the installation, retaining `.previous-*` directories and preserving projects and Godot export templates. Damaged bundled Node/Python require reinstalling Desktop. Manual lock-recovery diagnostics indicate that recovery state cannot be established reliably.

`apps/desktop/resources/environments/` ships outside ASAR at `runtime/environments/`, beside Godot resources. `apps/desktop/src/product/runtime-environment.ts` publishes commands and child-process environment; `apps/desktop-host/src/environments.ts` registers tools and skills. Desktop `main.ts` and Host `index.ts` own the concentrated integration. Supported targets are macOS arm64/x64 and Windows x64. Downloads require network access; The native installer installs only the app. Startup does not probe or prepare engines. The application menu provides a sandboxed management window with fixed component actions and cancellation. Managed downloads use verified caches, staging and retained previous directories; they do not modify external installations.

After an upstream merge, check primary-runtime metadata, Blender/npm locks, the Godot repair method, resource delivery, new-terminal resolution, plugin lifecycle and project venv behavior. Actual checks and platform coverage live in [REQ-005](../requirements/REQ-005-runtime-manager.md).

Native macOS DMG / Windows NSIS install only the desktop app. Godot 4.6.stable official builds and Blender 4.5+ / 5.x are detected through PATH and standard application locations and reused after version verification. Other versions remain untouched. The templates target prepares Godot export templates independently. Closing the manager cancels its work without closing the workspace.
