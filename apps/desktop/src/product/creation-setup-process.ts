/** Trusted installer child with bounded progress and process-tree cancellation. */
import { spawn } from 'node:child_process'

/** Main-owned paths for the bundled installer. */
export interface CreationSetupProcessOptions {
  readonly action?: 'status' | 'doctor' | 'ensure' | 'repair'
  readonly target?: 'all' | 'node' | 'python' | 'godot' | 'blender' | 'templates'
  readonly onReport?: (report: string) => void
  readonly checkOnly?: boolean
  readonly node: string
  readonly cli: string
  readonly config: string
  readonly environment: NodeJS.ProcessEnv
  readonly signal: AbortSignal
  readonly onProgress: (line: string) => void
}

/**
 * Run all preparation in a separate process before starting the Host.
 * @param options - Fixed installer paths and lifetime owned by the desktop window.
 * @returns Resolves after successful child exit; cancellation waits for process exit.
 */
export async function runCreationSetup(options: CreationSetupProcessOptions): Promise<void> {
  options.signal.throwIfAborted()
  const env = Object.fromEntries(Object.entries(options.environment).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
  const child = spawn(options.node, ['--use-env-proxy', options.cli, '--config', options.config, '--mode', 'env', ...(options.action ? [options.action, ...(options.action === 'status' ? [] : [options.target ?? 'all'])] : [options.checkOnly ? 'check-desktop' : 'prepare-desktop'])],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  let report = ''
  child.stdout.on('data', (chunk: Buffer) => { report = (report + chunk.toString('utf8')).slice(-65536) })
  let progressFailure: unknown
  let tail = ''
  let pending = ''
  let forced: ReturnType<typeof setTimeout> | undefined
  let termination: Promise<void> | undefined
  const terminate = (): void => {
    if (child.pid === undefined || termination !== undefined) return
    const pid = child.pid
    if (process.platform === 'win32') {
      termination = new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', () => { child.kill(); resolve() })
        killer.once('close', () =>{  resolve() })
      })
    } else {
      const killGroup = (signal: NodeJS.Signals): void => {
        try { process.kill(-pid, signal) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
        }
      }
      killGroup('SIGTERM')
      forced = setTimeout(() =>{  killGroup('SIGKILL') }, 3000)
      termination = Promise.resolve()
    }
  }
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    tail = (tail + text).slice(-4096)
    pending = (pending + text).slice(-8192)
    const lines = pending.split(/\r?\n/u)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (/^(?:Setup-stage:|Setup:|Godot:|Environment:)/u.test(line)) {
        try { options.onProgress(line.slice(0, 1024)) } catch (error) { progressFailure = error; terminate() }
      }
    }
  })
  options.signal.addEventListener('abort', terminate, { once: true })
  if (options.signal.aborted) terminate()
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (progressFailure !== undefined) reject(progressFailure instanceof Error ? progressFailure : new Error('Creation setup progress could not be displayed'))
        else if (options.signal.aborted) reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('Creation setup cancelled'))
        else if (code === 0 || options.action === 'doctor' && code === 1 && report.trim().startsWith('{')) { options.onReport?.(report); resolve() }
        else reject(new Error(`Creation environment preparation failed (${String(code ?? signal)}): ${tail.trim()}`))
      })
    })
  } finally {
    options.signal.removeEventListener('abort', terminate)
    if (termination !== undefined && process.platform !== 'win32' && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
    if (forced !== undefined) clearTimeout(forced)
    await termination
  }
}
