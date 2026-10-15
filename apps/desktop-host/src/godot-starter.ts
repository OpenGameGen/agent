/** Product-owned blank Godot project scaffolding through the ordinary sandbox. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, join } from 'node:path'

export const name = 'desktop-godot-starter'
export const inject = ['tools', 'subprocess', 'sandbox', 'sandboxPolicy']

/** Trusted bundled locations, supplied only by the Desktop profile. */
export interface Config {
  readonly resources: string
  readonly primaryRuntime: string
}

/** Register independent scaffolding without changing an existing project. */
export function apply(ctx: Context, config: Config): void {
  if (![config.resources, config.primaryRuntime].every(isAbsolute)) throw new Error('Starter requires absolute trusted runtime paths')
  const node = join(config.primaryRuntime, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  ctx.tools.register(defineTool({
    name: 'godot_project_create',
    description: 'Create a versioned blank Godot 4.6 project in a new or empty directory inside the workspace. Parent directory must exist; symlinks and existing content are rejected. 2d/3d includes a visible placeholder, bound Main.gd, main scene and Web-compatible rendering. Includes licensed Noto Sans SC font and font-only Autoload for Chinese UI. No controls, objectives or gameplay are implemented. Returns source and SHA-256 file manifest. Creation is exclusive per file, not crash-atomic; inspect partial files after interruption. Then implement gameplay, run godot-project check and test it in the browser.',
    parameters: {
      project: { type: 'string', required: true, description: 'Absolute new/empty project directory inside the current workspace; parent must already exist.' },
      dimension: { type: 'string', enum: ['2d', '3d'], required: true, description: 'Use 2d unless the requested game requires 3d.' },
      title: { type: 'string', description: 'Optional project display name, 1–80 characters; defaults to Untitled Game.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      if (policy.mode === 'read-only') throw new Error('Creating a project requires workspace-write permission')
      exec.signal.throwIfAborted()
      const argv = [node, join(config.resources, 'starter.mjs'), JSON.stringify({ workspace: policy.workspaceRoot, ...args })]
      const confined = policy.mode === 'danger-full-access' ? argv : (await ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, exec.signal)).argv
      const handle = ctx.subprocess.spawn({ argv: confined, cwd: policy.workspaceRoot, signal: exec.signal,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } }, graceMs: 1000 })
      try {
        const outcome = await handle.done
        exec.signal.throwIfAborted()
        if (outcome.exitCode !== 0) throw new Error(`Godot project creation failed: ${handle.collected.stderr?.readFrom(0).text ?? String(outcome.exitCode)}`)
        return handle.collected.stdout?.readFrom(0).text ?? ''
      } finally { handle.terminate(); await handle.waitForExit() }
    },
    presentCall: () => ({ card: 'generic', title: 'Create blank Godot project', kind: 'edit' }),
  }))
}
