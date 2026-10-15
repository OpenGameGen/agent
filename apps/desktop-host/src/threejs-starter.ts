/** Product-owned playable Three.js starter scaffolding through the ordinary sandbox. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const name = 'desktop-threejs-starter'
export const inject = ['tools', 'subprocess', 'sandbox', 'sandboxPolicy']

/** Trusted bundled locations, supplied only by the Desktop profile. */
export interface Config {
  readonly primaryRuntime: string
}

/** Register independent scaffolding without changing an existing project. */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.primaryRuntime)) throw new Error('Starter requires absolute trusted runtime paths')
  const node = join(config.primaryRuntime, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  ctx.tools.register(defineTool({
    name: 'threejs_project_create',
    description: 'Create a small playable Three.js + Vite coin-collection starter in a new or empty workspace directory. Contains movement, objective, timer, win/loss, restart and window.__game inspection. Uses pinned local npm dependencies. No dependencies are installed by this call; use managed Node/pnpm, install, customize the requested game, run dev/build and test with real browser inputs. Rejects paths outside workspace and symlink destinations. Creation is exclusive per file; interruption may leave partial files.',
    parameters: {
      project: { type: 'string', required: true, description: 'Absolute new/empty project directory inside the current workspace; parent must already exist.' },
      title: { type: 'string', description: 'Optional project display name, 1–80 characters; defaults to Untitled Game.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      if (policy.mode === 'read-only') throw new Error('Creating a project requires workspace-write permission')
      exec.signal.throwIfAborted()
      const source = readFileSync(fileURLToPath(new URL('../resources/threejs/starter.mjs', import.meta.url)), 'utf8')
      const argv = [node, '--input-type=module', '--eval', source + '\nconsole.log(JSON.stringify(await createProject(JSON.parse(process.argv[1]))));', JSON.stringify({ workspace: policy.workspaceRoot, ...args })]
      const confined = policy.mode === 'danger-full-access' ? argv : (await ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, exec.signal)).argv
      const handle = ctx.subprocess.spawn({ argv: confined, cwd: policy.workspaceRoot, signal: exec.signal,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } }, graceMs: 1000 })
      try {
        const outcome = await handle.done
        exec.signal.throwIfAborted()
        if (outcome.exitCode !== 0) throw new Error(`Three.js project creation failed: ${handle.collected.stderr?.readFrom(0).text ?? String(outcome.exitCode)}`)
        return handle.collected.stdout?.readFrom(0).text ?? ''
      } finally { handle.terminate(); await handle.waitForExit() }
    },
    presentCall: () => ({ card: 'generic', title: 'Create Three.js game', kind: 'edit' }),
  }))
}
