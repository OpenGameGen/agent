/** Product runtime management through trusted resource commands; project execution stays confined. */
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-skill'

/** Product plugin identity. */
export const name = 'desktop-environments'
/** Managed processes and model-visible registries. */
export const inject = ['tools', 'subprocess', 'skills']
/** Application-selected resources; no model-provided paths or download URLs. */
export interface Config {
  /** Upper bound for installation and lock waiting. */
  readonly timeoutMs: number
  readonly launcherConfig: string
  readonly resources: string
  readonly primaryRuntime: string
}

/**
 * Register inspection and preparation without granting arbitrary project execution.
 * @param ctx - Desktop profile tool scope.
 * @param config - Private launch configuration and bundled standalone Node.
 */
export function apply(ctx: Context, config: Config): void {
  for (const path of [config.launcherConfig, config.resources, config.primaryRuntime]) if (!isAbsolute(path)) throw new Error('Environment plugin requires absolute paths')
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2147483647) {
    throw new Error('Environment timeoutMs must be a positive timer-safe integer')
  }
  const node = join(config.primaryRuntime, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  ctx.tools.register(defineTool({
    name: 'manage_runtime_environment',
    description: 'Detect compatible locally installed Blender/Godot and inspect, check, install or repair fixed desktop runtimes and Godot export templates. Downloads use product-pinned checksums and user-owned directories. status and doctor never download. node preparation also installs npm; Python and Node ship with the app. Use ordinary confined shell tools for project .venv, dependencies, scripts and GUI launch. Remote machines have separate environments.',
    parameters: {
      action: { type: 'string', enum: ['status', 'doctor', 'ensure', 'repair'], required: true, description: 'Read status; run health checks; prepare runtime; or repair managed downloads. Damaged bundled interpreters need a desktop reinstall.' },
      runtime: { type: 'string', enum: ['all', 'node', 'python', 'blender', 'godot', 'templates'], description: 'Defaults to all. status always reports all runtimes.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.report }] },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const handle = ctx.subprocess.spawn({
        argv: [node, '--use-env-proxy', join(config.resources, 'cli.mjs'), '--config', config.launcherConfig, '--mode', 'env', args.action,
          ...(args.action === 'status' ? [] : [args.runtime ?? 'all'])],
        cwd: config.resources,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 8192 } },
        graceMs: 3000, signal: exec.signal,
      })
      try {
        const outcome = await handle.done
        exec.signal.throwIfAborted()
        const report = handle.collected.stdout?.readFrom(0).text ?? ''
        // Doctor uses exit 1 to report missing/unhealthy runtimes, as readable diagnostics.
        if (outcome.exitCode !== 0 && !(args.action === 'doctor' && outcome.exitCode === 1 && report.startsWith('{'))) {
          throw new Error(`Environment ${args.action} failed (${String(outcome.signal ?? outcome.exitCode)}): ${handle.collected.stderr?.readFrom(0).text ?? ''}`)
        }
        return { report }
      } finally { handle.terminate(); await handle.waitForExit() }
    },
    presentCall: args => ({ card: 'generic', title: `Environment: ${args.action}`, kind: args.action === 'status' || args.action === 'doctor' ? 'read' : 'fetch' }),
  }))
  ctx.skills.register({ name: 'managed-development-environments', source: 'bundled',
    description: 'Use desktop-managed Node.js, Python, Blender and Godot with project-local dependencies.',
    content: `# Managed development environments

Never ask local desktop users to install Node.js, Python, Blender or Godot manually. manage_runtime_environment reports paths and prepares pinned tools. First call status or doctor to detect compatible system Blender/Godot and their actual paths. Reuse compatible system installations. If missing or incompatible, call ensure with the required component; never use shell commands, package managers or arbitrary URLs to install Blender/Godot. Templates are a separate ensure templates operation. Call this fixed tool before confined shell execution that needs a downloaded runtime. Node.js and Python ship with the desktop; Node preparation adds npm/npx. Follow the selected engine: use Node/pnpm and webgame tools for Three.js, existing Godot tools for Godot mode, and normal coding tools for general mode. Do not prepare Godot or Blender for plain browser tasks unless needed. Downloads may take minutes. Remote SSH hosts have separate environments.

Local terminals inherit node, npm, npx, pnpm, python, python3, pip, pip3, blender, godot and agent-env. No system PATH or shell startup files are edited. Use agent-env status and agent-env doctor all for diagnostics. agent-env ensure blender prepares Blender; agent-env open blender opens its full interface only when the user requests manual modeling. Otherwise use blender --background --factory-startup --python <script> through ordinary shell tools. Blender uses its own Python.

For project dependencies, use ordinary confined shell/terminal tools: agent-env project "<existing directory>" --python --node creates .venv and records shipped versions in .agent-environment.json. It preserves existing environments and rejects conflicting recorded versions. It does not install application dependencies. Use npm install or pnpm install inside the project, never global installs. Use .venv/bin/python -m pip (Windows: .venv\\Scripts\\python.exe -m pip). The python and pip launchers select the current directory's .venv or VIRTUAL_ENV; outside a venv pip refuses installation. Do not install packages into bundled interpreters. Native npm/pip dependencies may need additional compilers or system libraries; report concrete failures.

Managed downloads are pinned by this desktop release, not an arbitrary-version selector. Compatible existing Blender 4.5+ / 5.x and matching official Godot versions are reused, with actual executable paths and versions returned by status. Repair re-verifies managed downloads and retains the previous Blender/npm installation. It never deletes projects. Damaged bundled Python/Node require reinstalling the desktop; Godot repair preserves its existing installer and templates. Report doctor failures and remaining platform checks honestly.
`,
  })
}
