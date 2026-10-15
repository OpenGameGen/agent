/** Short-lived, confined native resource editing for the product Godot tools. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'

/** Explicit Desktop-owned lifetime and protocol limits. */
export interface WorkerConfig {
  readonly idleMs: number
  readonly requestMs: number
  readonly maxBytes: number
}

class GodotOperationError extends Error {}

/** A validated native mutation in one bounded batch. */
export interface GodotBatchEdit {
  readonly operation: string
  readonly args: Readonly<Record<string, string | number>>
}

interface LiveWorker {
  readonly registry: string
  readonly key: string
  readonly owner: ToolExecution['agent']
  readonly handle: SubprocessHandle
  readonly temporary: string
  readonly lines: ReturnType<typeof createInterface>
  pending?: { accept: (value: string) => void; reject: (error: Error) => void } | undefined
  failure?: Error
}

/**
 * Build the serialized resource editor; plugin disposal awaits process cleanup.
 * @param ctx - Product scope with subprocess and per-session sandbox services.
 * @param runtime - Application-owned executable/script locations.
 * @param config - Idle expiry, operation deadline, and complete protocol size cap.
 * @returns Request and shutdown functions used by the built-in tools.
 */
export function createGodotWorker(
  ctx: Context, runtime: { root: string; resources: string; node: string; python: string }, config: WorkerConfig,
) {
  for (const limit of [config.idleMs, config.requestMs, config.maxBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2 ** 31 - 1) throw new Error('Godot worker limits must be positive timer-safe integers')
  }
  let live: LiveWorker | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let tail = Promise.resolve()
  let disposed = false

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation)
    tail = next.then(() => {}, () => {})
    return next
  }

  async function close(): Promise<void> {
    clearTimeout(idle)
    const worker = live
    live = undefined
    if (worker === undefined) return
    worker.pending?.reject(new Error('Godot worker stopped; inspect files before retrying an interrupted edit'))
    worker.pending = undefined
    worker.lines.close()
    if (worker.failure === undefined && !disposed && !worker.handle.stdin?.destroyed) {
      worker.handle.stdin?.end(JSON.stringify({ operation: 'stop' }) + '\n')
      if (!await worker.handle.waitForExit(AbortSignal.timeout(1000))) worker.handle.terminate()
    } else worker.handle.terminate()
    await worker.handle.waitForExit()
    await rm(worker.temporary, { recursive: true, force: true })
  }

  async function localResource(project: string, path: string): Promise<string> {
    const parts = path.replace(/^res:\/\//u, '').split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..' || /[\\:\u0000]/u.test(part))) {
      throw new Error('Use a project-relative resource path without traversal or drive prefixes')
    }
    const absolute = join(project, ...parts)
    // Existing targets and parent directories must resolve inside the project.
    let canonical: string
    try { canonical = await realpath(absolute) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      try { canonical = await realpath(dirname(absolute)) } catch (parentError) {
        if (!(parentError instanceof Error && 'code' in parentError && parentError.code === 'ENOENT')) throw parentError
        throw new Error(`Parent directory "${parts.slice(0, -1).join('/') || '.'}" does not exist or contains a dangling link. Create the project-local parent directory before retrying this Godot operation; directories are not created automatically.`)
      }
    }
    const remainder = relative(project, canonical)
    if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw new Error('Resource symlink escapes the project')
    return `res://${parts.join('/')}`
  }

  async function normalizeEdit(project: string, operation: string, args: Readonly<Record<string, string | number>>) {
    const normalized = { ...args }
    if (typeof normalized.path === 'string') {
      normalized.path = await localResource(project, normalized.path)
      const extension = /^(?:scene_.*|node_.*|signal_connect|animation_bind|tile_cells?)$/u.test(operation) ? '.tscn' : '.tres'
      if (!normalized.path.endsWith(extension)) throw new Error(`This Godot operation requires a ${extension} file`)
    }
    if (typeof normalized.reference === 'string' && normalized.reference !== '') normalized.reference = await localResource(project, normalized.reference)
    const nodeFields = operation === 'node_edit' && args.action === 'reparent' || operation === 'signal_connect' ? ['target'] : []
    for (const field of ['node', 'parent', ...nodeFields]) {
      const value = normalized[field]
      if (typeof value === 'string' && (value.startsWith('/') || value.split('/').includes('..'))) throw new Error('Use a scene-local node path')
    }
    return normalized
  }

  async function registryFingerprint(project: string): Promise<string> {
    const hash = createHash('sha256')
    for (const path of ['project.godot', '.godot/global_script_class_cache.cfg']) {
      hash.update(path)
      try {
        const canonical = await realpath(join(project, path))
        const remainder = relative(project, canonical)
        if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
          throw new GodotOperationError('Godot registry file symlink escapes the project')
        }
        hash.update(await readFile(canonical))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        hash.update('missing')
      }
    }
    return hash.digest('hex')
  }

  async function exchange(worker: LiveWorker, message: string): Promise<Record<string, unknown>> {
    const result = await new Promise<string>((accept, reject) => {
      worker.pending = { accept, reject }
      worker.handle.stdin?.write(message, (error) => { if (error !== null && error !== undefined) reject(error) })
    })
    const parsed: unknown = JSON.parse(result.slice('OPENGAME_RESOURCE_RESULT'.length))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid Godot worker response')
    return parsed as Record<string, unknown>
  }

  async function request(
    projectInput: string, operation: string, args: Readonly<Record<string, string | number>>, exec: ToolExecution,
    batch?: readonly GodotBatchEdit[],
  ): Promise<string> {
    return exclusive(async () => {
      exec.signal.throwIfAborted()
      if (disposed) throw new Error('Godot plugin disposed')
      const project = await realpath(projectInput)
      await access(join(project, 'project.godot'))
      const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      const root = await realpath(policy.workspaceRoot)
      const remainder = relative(root, project)
      if (policy.mode !== 'danger-full-access' && (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder))) {
        throw new Error('Godot project must be inside the current workspace')
      }
      if (policy.mode === 'read-only') {
        throw new Error('Native Godot resource tools require workspace-write for transient engine files; use file read tools under read-only permission')
      }
      const normalized = batch === undefined ? await normalizeEdit(project, operation, args) : {
        operations: await Promise.all(batch.map(async (edit, index) => {
          try { return { ...await normalizeEdit(project, edit.operation, edit.args), operation: edit.operation } }
          catch (error) { throw new Error(`Batch step ${index}: ${error instanceof Error ? error.message : String(error)}`) }
        })),
      }
      const payload = JSON.stringify({ ...normalized, operation: operation === 'batch' ? 'batch_prepare' : operation }) + '\n'
      if (Buffer.byteLength(payload) > Math.min(config.maxBytes, 65535)) throw new Error('Godot operation too large; split into smaller edits')
      clearTimeout(idle)
      const key = JSON.stringify([project, policy])
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.requestMs)])
      const interrupted = () => signal.aborted
      let refreshed = false
      let batchInFlight = false
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      const terminateInterrupted = () => {
        live?.pending?.reject(new Error('Godot operation interrupted; rollback unknown; inspect files before retrying the edit'))
        live?.handle.terminate()
      }
      const abort = () => {
        // Keep the serialized worker alive to drain a prepared batch and roll it
        // back. A hung script still has a bounded, explicitly uncertain fallback.
        if (batchInFlight) cleanupTimer = setTimeout(terminateInterrupted, 3000)
        else terminateInterrupted()
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (live !== undefined && (live.key !== key || live.owner !== exec.agent || live.failure !== undefined)) await close()
        const registry = await registryFingerprint(project)
        const resolvingHistory = operation === 'transaction' && ['commit', 'rollback', 'undo'].includes(String(args.action))
        if (live !== undefined && live.registry !== registry && !resolvingHistory) {
          const state = await exchange(live, JSON.stringify({ operation: 'worker_state' }) + '\n')
          if (typeof state.transaction_active !== 'boolean' || typeof state.has_undo !== 'boolean') {
            throw new GodotOperationError('Cannot verify Godot worker history before registry refresh; explicitly stop the worker after inspecting edits.')
          }
          if (state.transaction_active || state.has_undo) {
            throw new GodotOperationError('Godot project settings or global class registry changed outside this worker. Native history was preserved: '
              + `transaction_active=${String(state.transaction_active)}, has_undo=${String(state.has_undo)}. `
              + 'Resolve the existing group with godot_edit_transaction commit/rollback/undo (commit may retain undo), '
              + 'or explicitly godot_worker_stop to discard worker-local history, then retry. The script was not evaluated or changed.')
          }
          await close()
          refreshed = true
        }
        if (live === undefined) {
          await access(join(runtime.root, 'engine', 'installed.json'))
          const temporary = await mkdtemp(join(project, '.opengame-godot-worker-'))
          const argv = [runtime.node, '--use-env-proxy', join(runtime.resources, 'cli.mjs'), '--runtime', runtime.root,
            '--python', runtime.python, '--mode', 'engine', '--headless', '--log-file', join(temporary, 'engine.log'), '--path', project, '--script', join(runtime.resources, 'resource-worker.gd')]
          let handle: SubprocessHandle
          try {
            const confined = policy.mode === 'danger-full-access' ? argv : (await ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)).argv
            signal.throwIfAborted()
            handle = ctx.subprocess.spawn({ argv: confined, cwd: project,
              stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: config.maxBytes } }, graceMs: 3000 })
          } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
          if (handle.stdin === undefined || handle.stdout === undefined) {
            handle.terminate()
            await handle.waitForExit()
            await rm(temporary, { recursive: true, force: true })
            throw new Error('Godot worker protocol pipes unavailable')
          }
          const lines = createInterface({ input: handle.stdout })
          const worker: LiveWorker = { registry, key, owner: exec.agent, handle, lines, temporary }
          live = worker
          const ready = new Promise<string>((accept, reject) => { worker.pending = { accept, reject } })
          let lineBytes = 0
          handle.stdout.on('data', (chunk: Buffer) => {
            // readline itself has no cap for an unterminated line.
            const last = chunk.lastIndexOf(10)
            lineBytes = last < 0 ? lineBytes + chunk.length : chunk.length - last - 1
            if (lineBytes > config.maxBytes || chunk.length > config.maxBytes) {
              worker.failure = new Error('Godot worker output exceeds configured limit')
              worker.pending?.reject(worker.failure)
              handle.terminate()
            }
          })
          lines.on('line', (line) => {
            if (Buffer.byteLength(line) > config.maxBytes) {
              worker.failure = new Error('Godot worker response exceeds configured limit')
              worker.pending?.reject(worker.failure)
              handle.terminate()
              return
            }
            if (line === 'OPENGAME_RESOURCE_READY' || line.startsWith('OPENGAME_RESOURCE_RESULT')) {
              const pending = worker.pending
              worker.pending = undefined
              pending?.accept(line)
            }
          })
          const failed = (error: Error) => {
            worker.failure = error
            worker.pending?.reject(error)
            worker.pending = undefined
          }
          handle.stdin.on('error', failed)
          handle.stdout.on('error', failed)
          void handle.done.then((outcome) => {
            failed(new Error(`Godot worker exited (${String(outcome.signal ?? outcome.exitCode)}). Inspect files before retrying an edit. ${handle.collected.stderr?.readFrom(0).text ?? ''}`))
          }, (error: unknown) => { failed(error instanceof Error ? error : new Error(String(error))) })
          await ready
        }
        signal.throwIfAborted()
        const worker = live
        batchInFlight = operation === 'batch'
        let value = await exchange(worker, payload)
        if (operation === 'batch' && !('error' in value)) {
          if (interrupted()) {
            const rollback = await exchange(worker, JSON.stringify({ operation: 'transaction', action: 'rollback' }) + '\n')
            throw new GodotOperationError(JSON.stringify({ error: 'Batch interrupted', rollback: 'error' in rollback ? 'failed' : 'completed', details: rollback }))
          }
          const committed = await exchange(worker, JSON.stringify({ operation: 'transaction', action: 'commit' }) + '\n')
          if ('error' in committed) throw new Error(`Batch commit failed: ${JSON.stringify(committed)}`)
          if (interrupted()) throw new GodotOperationError('Batch committed; cancellation arrived after commit was requested. No undo was performed. Inspect the committed files.')
          value = { data: { ...value.data as Record<string, unknown>, status: 'committed', undo: 'Latest worker-local edit group; undo restores this whole batch. History expires when worker stops.' } }
        }
        idle = setTimeout(() => { void exclusive(close).catch((error: unknown) => { console.error('Godot worker cleanup failed:', error) }) }, config.idleMs)
        idle.unref()
        // A structured rejection is recoverable. Keep native history and the
        // engine alive so the model can inspect/correct arguments and retry.
        if ('error' in value) throw new GodotOperationError(operation === 'batch' ? JSON.stringify(value) : String(value.error))
        if (!('saved' in value || 'class' in value || 'data' in value || 'track' in value)) throw new Error('Godot operation returned no result; inspect files before retrying')
        return JSON.stringify(refreshed ? { ...value, worker_refresh: 'Reloaded changed project settings/global class registry; no active transaction or undo history was discarded.' } : value)
      } catch (error) {
        if (!(error instanceof GodotOperationError)) await close()
        else {
          clearTimeout(idle)
          idle = setTimeout(() => { void exclusive(close).catch((cleanupError: unknown) => { console.error('Godot worker cleanup failed:', cleanupError) }) }, config.idleMs)
          idle.unref()
        }
        throw error
      } finally { clearTimeout(cleanupTimer); signal.removeEventListener('abort', abort) }
    })
  }

  ctx.on('agent/turn-stopping', ({ agent }) => exclusive(async () => { if (live?.owner === agent) await close() }))
  ctx.effect(() => async () => { disposed = true; live?.handle.terminate(); await exclusive(close) })
  return { request, stop: () => exclusive(async () => { await close(); return 'Godot resource worker stopped' }) }
}
