/** Built-in Godot Web testing, with one reusable right-Sidebar page per task. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { dump } from 'js-yaml'
import { createHash, randomUUID } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { createGameTransport, type GameTransport } from './game-transport.ts'
import { gameExportAvailable, gameFingerprint, installGameHarness, serveGame, stageGame } from './game-build.ts'
import { compareReproductionTraces, parseReproductionTest } from './game-reproduce.ts'
import { gameKeys, gameRecord, gameString, observeGameAssertion, parseGameTest } from './game-tests.ts'

/** Product-owned plugin name. */
export const name = 'desktop-game-validation'
/** Public services used by the validation plugin. */
export const inject = ['tools', 'subprocess', 'sandbox', 'sandboxPolicy', 'attachments', 'systemPrompt']
/** Deployment paths and finite build/run budgets. */
export interface Config {
  root: string
  resources: string
  primaryRuntime: string
  buildMs: number
  operationMs: number
  idleMs: number
}
interface Run {
  id: string
  sessionId: string
  project: string
  temporary: string
  artifacts: string
  fingerprint: string
  runtimeFingerprint: string
  initialScene: string
  server: Awaited<ReturnType<typeof serveGame>>
  recording?: { steps: Record<string, unknown>[]; overflow: boolean } | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
}

/** @param ctx - Desktop Cordis scope. @param config - Explicit product paths and time budgets. */
export function apply(ctx: Context, config: Config): void {
  const transport = createGameTransport()
  ctx.effect(() => () => { transport.dispose() })
  registerGameValidation(ctx, config, transport.request)
}

/** Register tools against the production transport or an external browser fixture.
 * @param ctx - Public Cordis services. @param config - Product configuration. @param transport - Exact browser carrier.
 */
export function registerGameValidation(ctx: Context, config: Config, transport: GameTransport): void {
  for (const value of [config.buildMs, config.operationMs, config.idleMs]) if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error('Invalid game time budget')
  for (const value of [config.root, config.resources, config.primaryRuntime]) if (!isAbsolute(value)) throw new Error('Game paths must be absolute')
  const windows = process.platform === 'win32'
  const node = join(config.primaryRuntime, 'dependencies/node/bin', windows ? 'node.exe' : 'node')
  const python = join(config.primaryRuntime, 'dependencies/python', windows ? 'python.exe' : 'bin/python3')
  const runs = new Map<string, Run>()
  let tail = Promise.resolve()
  const disposal = new AbortController()
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation); tail = next.then(() => {}, () => {}); return next
  }
  function session(exec: ToolExecution): string {
    if (exec.agent === undefined) throw new Error('Game browser tools require an active task')
    return exec.agent.session.id
  }
  async function stop(run: Run): Promise<void> {
    clearTimeout(run.timer)
    if (runs.get(run.sessionId) !== run) return
    runs.delete(run.sessionId)
    try { await transport('stop', { runId: run.id, sessionId: run.sessionId }, AbortSignal.timeout(config.operationMs)) }
    finally { await run.server.close(); await rm(run.temporary, { recursive: true, force: true }) }
  }
  function touch(run: Run): void {
    clearTimeout(run.timer)
    const active = () => !disposal.signal.aborted && runs.get(run.sessionId) === run
    run.timer = setTimeout(() => { void serial(async () => {
      if (!active()) return
      try {
        const lifecycle = gameRecord(await transport('lifecycle', { runId: run.id, sessionId: run.sessionId },
          AbortSignal.any([disposal.signal, AbortSignal.timeout(config.operationMs)])))
        if (lifecycle.attached === false) { await stop(run); return }
      } catch (error) { if (active()) console.warn('Game lifecycle check unavailable; retaining preview', error) }
      // Agent inactivity is not player inactivity. Retain an open page, including when its status is uncertain.
      if (active()) touch(run)
    }).catch((error: unknown) => { console.error('Game cleanup failed', error) }) }, config.idleMs)
    run.timer.unref()
  }
  async function projectPath(input: string, exec: ToolExecution): Promise<string> {
    if (!isAbsolute(input)) throw new Error('game_start project must be an absolute directory path containing project.godot; resolve it from the task workspace first')
    const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    if (policy.mode === 'read-only') throw new Error('Game validation requires workspace-write for export and evidence')
    const project = await realpath(input)
    const root = await realpath(policy.workspaceRoot)
    const rel = relative(root, project)
    if (policy.mode !== 'danger-full-access' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error('Game project is outside the workspace')
    await access(join(project, 'project.godot'))
    return project
  }
  async function engine(args: string[], cwd: string, exec: ToolExecution, signal: AbortSignal): Promise<void> {
    const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    const argv = [node, '--use-env-proxy', join(config.resources, 'cli.mjs'), '--runtime', config.root, '--python', python, '--mode', 'engine', '--headless', ...args]
    const confined = policy.mode === 'danger-full-access' ? argv : (await ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)).argv
    signal.throwIfAborted()
    const handle = ctx.subprocess.spawn({ argv: confined, cwd, signal, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } } })
    try {
      const outcome = await handle.done
      signal.throwIfAborted()
      const log = stripVTControlCharacters((handle.collected.stdout?.readFrom(0).text ?? '') + (handle.collected.stderr?.readFrom(0).text ?? ''))
      if (outcome.exitCode !== 0 || /SCRIPT ERROR:|Parse Error:|ERROR:/u.test(log)) {
        const phase = args.includes('--import') ? 'import' : args.includes('--export-pack') ? 'resource export'
          : args.includes('--export-debug') ? 'Web export' : 'test-project preparation'
        const diagnostics = log.length <= 16000 ? log : `${log.slice(0, 8000)}\n[build output truncated]\n${log.slice(-8000)}`
        throw new Error(`Godot Web build failed during ${phase} (exit ${outcome.exitCode}). Source project: ${cwd}.\n`
          + `Project res:// paths below map to this source project; injected res://opengame_test/ errors belong to the desktop test harness and must be reported as tool failures. Edit the source file at the reported line, run godot-project check, then retry game_start. Do not edit the temporary .opengame-game-* build copy. A previous running game is retained when the build fails.\n${diagnostics}`)
      }
    } finally { handle.terminate(); await handle.waitForExit() }
  }
  async function browser(
    run: Run, operation: string, args: Record<string, unknown>, signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = gameRecord(await transport(operation, { ...args, runId: run.id, sessionId: run.sessionId },
      AbortSignal.any([signal, AbortSignal.timeout(config.operationMs)])))
    touch(run)
    return { ...result, observed_at: new Date().toISOString(), observation_clock: 'Host received this result at observed_at; not an exact engine frame timestamp.' }
  }
  async function screenshot(run: Run, signal: AbortSignal): Promise<Record<string, unknown>> {
    const captured = await browser(run, 'screenshot', {}, signal)
    if (typeof captured.png !== 'string' || captured.png.length > 24 * 1024 * 1024) throw new Error('Invalid screenshot bytes')
    const data = Buffer.from(captured.png, 'base64')
    const path = join(run.artifacts, `screenshot-${randomUUID()}.png`)
    await writeFile(path, data, { flag: 'wx', mode: 0o600 })
    const image = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'game.png' })
    return { path, image, captured_at: captured.observed_at, observation_clock: captured.observation_clock,
      temporal_context: 'Saved historical screenshot: captured_at is when the host received capture bytes, not an exact engine frame time. The game keeps running; later tree/state observations may differ and are not the same snapshot.' }
  }
  async function assertion(run: Run, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    return observeGameAssertion(bounded => browser(run, 'state', { node_path: args.node, property: args.property }, bounded), args, signal)
  }

  async function advance(run: Run, args: Record<string, unknown>, signal: AbortSignal) {
    try { return await browser(run, 'step', args, signal) }
    catch (error) {
      // Cancellation aborts the RPC, not the engine coroutine. Pause with an
      // independent bounded request; bridge also has its own lost-request timer.
      try { await browser(run, 'freeze', {}, AbortSignal.timeout(3000)) }
      catch (cleanup) { console.warn('Frame step pause recovery failed', cleanup) }
      throw error
    }
  }

  async function reproduce(run: Run, file: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (run.recording !== undefined) throw new Error('Stop game_record before reproduction')
    const path = await realpath(isAbsolute(file) ? file : join(run.project, file))
    const rel = relative(run.project, path)
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Reproduction manifest must be inside the project')
    if ((await stat(path)).size > 65536) throw new Error('Reproduction manifest exceeds 64 KiB')
    const test = parseReproductionTest(await readFile(path, 'utf8'))
    const exported = join(run.temporary, 'web')
    const runtime = async () => await gameFingerprint(config.resources, signal) + await readFile(join(config.root, 'engine/installed.json'), 'utf8')
    const verify = async () => {
      if (await gameFingerprint(run.project, signal) !== run.fingerprint || await runtime() !== run.runtimeFingerprint) throw new Error('Project or runtime changed; call game_start before reproduction')
      if (!await gameExportAvailable(exported)) throw new Error('Preview export is missing; call game_start again')
    }
    await verify()
    const exportFingerprint = await gameFingerprint(exported, signal)
    const trials: Record<string, unknown>[] = []
    const reportPath = join(run.artifacts, `reproduction-${randomUUID()}.json`)
    const scope = 'Only declared observed properties after project-owned _opengame_reset(seed), in two isolated cold Web instances of this build. Not global or cross-platform determinism.'
    try {
      for (let trial = 0; trial < 2; trial++) {
        signal.throwIfAborted()
        const runId = randomUUID()
        const server = await serveGame(exported, runId)
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(120000)])
        const request = async (operation: string, args: Record<string, unknown>) => {
          const result = gameRecord(await transport(operation, { ...args, runId, sessionId: run.sessionId }, bounded))
          bounded.throwIfAborted()
          if (result.error !== undefined) throw new Error(`Reproduction ${operation} failed: ${JSON.stringify(result.error)}`)
          return result
        }
        let trialFailed = false
        try {
          const opened = await request('open', { url: server.url, isolation: true })
          if (opened.isolated !== true) throw new Error('Browser did not confirm an isolated cold instance')
          const result = await request('reproduce', { test })
          const errors = await request('errors', {})
          if (!Array.isArray(errors.errors) || errors.errors.length !== 0) throw new Error('Reproduction has runtime errors or missing error evidence')
          compareReproductionTraces(test, result.trace, result.trace)
          const physics = gameRecord(result.physics)
          if (!['ticks_per_second', 'max_steps_per_frame'].every(key => typeof physics[key] === 'number' && Number.isSafeInteger(physics[key]) && physics[key] > 0)
            || typeof physics.time_scale !== 'number' || !Number.isFinite(physics.time_scale) || physics.time_scale <= 0) throw new Error('Missing or invalid physics configuration')
          trials.push({ runId, trace: result.trace, physics, errors: errors.errors })
        } catch (error) { trialFailed = true; throw error }
        finally {
          try {
            try { await transport('stop', { runId, sessionId: run.sessionId }, AbortSignal.timeout(5000)) }
            finally { await server.close() }
          } catch (cleanup) {
            if (!trialFailed) throw cleanup
            console.warn('Reproduction cleanup failed after trial failure', cleanup)
          }
        }
      }
      await verify()
      if (await gameFingerprint(exported, signal) !== exportFingerprint) throw new Error('Export changed during reproduction; call game_start again')
      const first = trials[0], second = trials[1]
      if (first === undefined || second === undefined) throw new Error('Missing reproduction trial')
      // Canonical finite JSON comparison also validates the physics configuration.
      const physicsTest = { ...test, observations: [{ node: 'physics', property: 'config' }] }
      const physicsTrace = (physics: unknown) => {
        let tick = 0
        return [{ tick, values: [physics] }, ...test.steps.map((step) => {
          tick += step.physics_ticks
          return { tick, values: [physics] }
        })]
      }
      if (!compareReproductionTraces(physicsTest, physicsTrace(first.physics), physicsTrace(second.physics)).reproducibility_verified) throw new Error('Physics configuration differs between cold runs')
      const comparison = compareReproductionTraces(test, first.trace, second.trace)
      const report = { ...comparison, seed: test.seed, manifest: test, scope, trials,
        fingerprints: { project: run.fingerprint, runtime: createHash('sha256').update(run.runtimeFingerprint).digest('hex'), export: exportFingerprint } }
      signal.throwIfAborted()
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
      return { ...comparison, reportPath, seed: test.seed, scope, trials: 2, fingerprints: report.fingerprints }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await writeFile(reportPath, JSON.stringify({ status: signal.aborted ? 'interrupted' : 'incomplete', reproducibility_verified: false,
          seed: test.seed, manifest: test, scope, trials, error: message,
          fingerprints: { project: run.fingerprint, runtime: createHash('sha256').update(run.runtimeFingerprint).digest('hex'), export: exportFingerprint } }, null, 2), { flag: 'wx', mode: 0o600 })
      } catch (saving) { console.warn('Could not save partial reproduction evidence', saving); throw error }
      if (error instanceof Error) { error.message += ` Partial reproduction report: ${reportPath}`; throw error }
      throw new Error(`${message}. Partial reproduction report: ${reportPath}`, { cause: error })
    }
  }

  async function runTest(run: Run, file: string, signal: AbortSignal, replay = false): Promise<Record<string, unknown>> {
    const path = await realpath(isAbsolute(file) ? file : join(run.project, file))
    const rel = relative(run.project, path)
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new Error('Test file must be inside the project')
    if ((await stat(path)).size > 65536) throw new Error('Test file exceeds 64 KiB')
    const test = parseGameTest(await readFile(path, 'utf8'), !replay)
    const results: unknown[] = []
    const watches = new Map<string, number>()
    let status = test.steps.some(step => 'assert' in step || 'wait_signal' in step || 'wait_node' in step) ? 'passed' : 'unverified'
    let failure: string | undefined
    try {
      for (const step of test.steps) {
        signal.throwIfAborted()
        let result: unknown
        if ('wait_ms' in step) { await delay(Number(step.wait_ms), undefined, { signal }); result = { waited_ms: step.wait_ms } }
        else if ('freeze' in step || 'thaw' in step || 'step' in step) {
          const operation = 'freeze' in step ? 'freeze' : 'thaw' in step ? 'thaw' : 'step'
          result = operation === 'step' ? await advance(run, { frames: step.step, ...(step.clock === undefined ? {} : { clock: step.clock }) }, signal) : await browser(run, operation, {}, signal)
        } else if ('watch_signal' in step) {
          const spec = gameRecord(step.watch_signal)
          const response = await browser(run, 'watch', { node_path: spec.node, signal: spec.signal }, signal)
          watches.set(JSON.stringify([spec.node, spec.signal]), Number(response.cursor)); result = response
        } else if ('wait_signal' in step || 'wait_node' in step) {
          const spec = 'wait_signal' in step ? gameRecord(step.wait_signal) : undefined
          const cursor = spec === undefined ? undefined : watches.get(JSON.stringify([spec.node, spec.signal]))
          if (spec !== undefined && cursor === undefined) throw new Error('watch_signal must precede input and wait_signal')
          const deadline = Date.now() + Number(step.timeout_ms ?? 5000)
          let matched = false
          do {
            if (spec === undefined) {
              result = await browser(run, 'exists', { node_path: step.wait_node }, signal)
              matched = gameRecord(result).exists === true
            } else {
              const observed = await browser(run, 'events', { after: cursor }, signal)
              matched = Array.isArray(observed.events) && observed.events.some((event) => {
                const item = gameRecord(event); return item.node === spec.node && item.signal === spec.signal
              }); result = observed
            }
            if (matched) break
            await delay(50, undefined, { signal })
          } while (Date.now() < deadline)
          if (!matched) throw new Error('Test condition timed out')
        } else if ('assert' in step) {
          const spec = { ...gameRecord(step.assert), ...(step.timeout_ms === undefined ? {} : { timeout_ms: step.timeout_ms }) }
          result = await assertion(run, spec, signal)
          if (gameRecord(result).passed !== true) { results.push({ step, result }); status = 'failed'; break }
        } else if ('screenshot' in step) result = await screenshot(run, signal)
        else if ('keys' in step) result = await browser(run, 'keys', gameKeys(step.keys, step.duration_ms ?? 80), signal)
        else if ('key' in step) result = await browser(run, 'key', { key: step.key, duration_ms: step.duration_ms ?? 80 }, signal)
        else if ('click_ui' in step) result = await browser(run, 'click_ui', { node_path: step.click_ui }, signal)
        else result = await browser(run, 'click', gameRecord(step.click), signal)
        results.push({ step, result })
      }
      const errors = await browser(run, 'errors', {}, signal)
      if (Array.isArray(errors.errors) && errors.errors.length > 0) { results.push(errors); status = 'failed' }
    } catch (error) { status = 'incomplete'; failure = error instanceof Error ? error.message : String(error) }
    if ((status === 'failed' || status === 'incomplete') && !signal.aborted) {
      try { results.push({ evidence: await screenshot(run, signal) }) }
      catch (error) { results.push({ captureError: String(error) }) }
    }
    const evidencePaths = results.flatMap((entry) => {
      const item = gameRecord(entry)
      const captured = item.evidence ?? item.result
      if (typeof captured !== 'object' || captured === null || !('path' in captured) || !('image' in captured)) return []
      return typeof captured.path === 'string' ? [captured.path] : []
    })
    const report = { name: test.name, status, failure, runId: run.id, results,
      visual_verified: false, evidence_paths: evidencePaths,
      temporal_context: 'Each result and saved screenshot describes its own observation time. The game continues between steps and calls; saved frames and later tree/state are not one atomic snapshot.',
      next_action: evidencePaths.length > 0
        ? 'This report contains saved screenshot paths, not image input. Use read_image on evidence_paths to inspect the captured test moment (including failure evidence); do not claim visual verification before reading the images. Requires an image-capable model.'
        : 'No screenshot evidence was captured. Use state/assertion results; do not claim visual verification.',
      ...(replay ? { replay: true, deterministic: false, preconditions: 'Replays against current run state; no snapshot restore or raw user input recording' } : {}) }
    const reportPath = join(run.artifacts, `test-${randomUUID()}.json`)
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
    return { ...report, reportPath }
  }
  async function execute(operation: string, args: Record<string, unknown>, exec: ToolExecution): Promise<string> {
    return serial(async () => {
      const signal = AbortSignal.any([exec.signal, disposal.signal, AbortSignal.timeout(operation === 'start' ? config.buildMs : operation === 'reproduce' ? 300_000 : 120_000)])
      signal.throwIfAborted()
      if (operation === 'keys') args = gameKeys(args.keys, args.duration_ms ?? 80)
      const sessionId = session(exec)
      let run = runs.get(sessionId)
      if (operation === 'start') {
        if (run?.recording !== undefined) throw new Error('Stop game_record before restarting the game so recorded actions are saved')
        const project = await projectPath(gameString(args.project), exec)
        let scene = ''
        if (args.scene !== undefined) {
          scene = gameString(args.scene).replace(/^res:\/\//u, '')
          if (!scene.endsWith('.tscn') || scene.split(/[\\/]/u).includes('..') || isAbsolute(scene)) throw new Error('Use a project-relative .tscn scene')
          await access(join(project, scene)); scene = 'res://' + scene
        }
        let cacheRecovered = false
        if (run !== undefined && !await gameExportAvailable(join(run.temporary, 'web'))) {
          // Source files remain authoritative; disposable browser exports may have been removed externally.
          try { await stop(run) } catch (error) { console.warn('Missing game preview cache cleanup', error) }
          run = undefined
          cacheRecovered = true
        }
        const fingerprint = await gameFingerprint(project, signal)
        const runtimeFingerprint = await gameFingerprint(config.resources, signal) + await readFile(join(config.root, 'engine/installed.json'), 'utf8')
        if (run?.project === project && run.fingerprint === fingerprint && run.runtimeFingerprint === runtimeFingerprint) {
          const switched = await browser(run, 'scene', { scene: scene || run.initialScene }, signal)
          return JSON.stringify({ runId: run.id, url: run.server.url, ready: true, artifacts: run.artifacts, build: 'reused', ...switched })
        }
        const previous = run
        let reuseRuntime = previous?.runtimeFingerprint === runtimeFingerprint
        await access(join(config.root, 'engine/installed.json'))
        const temporary = await mkdtemp(join(project, '.opengame-game-'))
        let server: Awaited<ReturnType<typeof serveGame>> | undefined
        try {
          const staged = join(temporary, 'project'), exported = join(temporary, 'web')
          await stageGame(project, staged, signal)
          await installGameHarness(staged, config.resources)
          // Import first so native ResourceUID resolution is available to startup validation.
          await engine(['--path', staged, '--editor', '--import'], project, exec, signal)
          await engine(['--path', staged, '--script', join(config.resources, 'game-prepare.gd'), '--', scene], project, exec, signal)
          await mkdir(exported)
          if (reuseRuntime && previous !== undefined) {
            try { await cp(join(previous.temporary, 'web'), exported, { recursive: true }) }
            catch (error) {
              if (typeof error !== 'object' || error === null || !('code' in error) || !['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw error
              // Deletion can race the availability check. Discard the partial copy and export afresh.
              await rm(exported, { recursive: true, force: true }); await mkdir(exported)
              reuseRuntime = false
              cacheRecovered = true
            }
          }
          if (reuseRuntime) {
            await engine(['--path', staged, '--export-pack', 'OpenGame Web Test', join(exported, 'index.pck')], project, exec, signal)
            const html = join(exported, 'index.html')
            const bytes = (await stat(join(exported, 'index.pck'))).size
            await writeFile(html, (await readFile(html, 'utf8')).replace(/("index\.pck"\s*:\s*)\d+/u, `$1${bytes}`))
          } else {
            await engine(['--path', staged, '--export-debug', 'OpenGame Web Test', join(exported, 'index.html')], project, exec, signal)
          }
          if (await gameFingerprint(project, signal) !== fingerprint) throw new Error('Project changed during build; retry game_start. Previous run is retained.')
          const id = randomUUID()
          const artifactRoot = join(project, '.opengame-test-results')
          await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
          if (await realpath(artifactRoot) !== join(project, '.opengame-test-results')) throw new Error('Evidence directory must not be a symlink')
          const artifacts = join(artifactRoot, id)
          await mkdir(artifacts, { mode: 0o700 })
          server = await serveGame(exported, id)
          run = { id, sessionId, project, temporary, artifacts, server, fingerprint, runtimeFingerprint, initialScene: scene }
          await browser(run, 'open', { url: server.url }, signal)
          if (previous !== undefined) await stop(previous)
          runs.set(sessionId, run); touch(run)
          return JSON.stringify({ runId: id, url: server.url, ready: true, artifacts, build: reuseRuntime ? 'resources' : 'full', ...(cacheRecovered ? { cache_recovered: true, recovery: 'Previous preview export was missing; rebuilt from source' } : {}) })
        } catch (error) {
          if (run?.temporary === temporary) { clearTimeout(run.timer); await transport('stop', { runId: run.id, sessionId }, AbortSignal.timeout(config.operationMs)).catch(() => undefined) }
          await server?.close(); await rm(temporary, { recursive: true, force: true })
          if (cacheRecovered) throw new Error(`Previous preview cache was missing and could not be retained. Rebuild failed; fix the source project and retry game_start. ${error instanceof Error ? error.message.replace('A previous running game is retained when the build fails.', '') : String(error)}`)
          throw error
        }
      }
      if (run === undefined) throw new Error('Call game_start for this task first')
      if (operation !== 'stop') await projectPath(run.project, exec)
      clearTimeout(run.timer)
      try {
        let result: unknown
        if (operation === 'stop') {
          if (run.recording !== undefined) throw new Error('Stop game_record before stopping the game so recorded actions are saved')
          await stop(run); result = { stopped: true }
        }
        else if (operation === 'reproduce') result = await reproduce(run, gameString(args.test_file), signal)
        else if (operation === 'screenshot') {
          const captured = await screenshot(run, signal)
          // Match read_image's exact active-route gate using the public model catalog.
          // A screenshot file remains useful to users even when this route cannot see it.
          const routed = exec.agent?.session.requestHeader()?.config
          const provider = routed?.provider ?? exec.agent?.options.provider
          const model = routed?.model ?? exec.agent?.options.model
          const llm = ctx.get('llm')
          let visualError: string | undefined
          if (provider === undefined || model === undefined || llm === undefined) visualError = 'Current model route could not be resolved'
          else {
            try {
              const active = await llm.resolveModelInfo(provider, model, signal)
              if (!active.inputModalities?.includes('image')) visualError = `Model ${model} does not declare image input`
            } catch (error) {
              signal.throwIfAborted()
              visualError = `Image capability lookup failed: ${error instanceof Error ? error.message : String(error)}`
            }
          }
          const { image: _image, ...savedEvidence } = captured
          result = visualError === undefined ? captured : { ...savedEvidence, visual_verified: false, image_attached: false,
            error: visualError, next_action: 'PNG saved, but the model has not viewed it. Use game_tree/game_state/game_assert or switch to an image-capable model and read_image this path.' }
        }
        else if (operation === 'assert') result = await assertion(run, { node: args.node_path, property: args.property, operator: args.operator, expected: JSON.parse(gameString(args.expected)), timeout_ms: args.timeout_ms }, signal)
        else if (operation === 'wait_signal') {
          const deadline = Date.now() + 10_000
          let matched = false
          do {
            const response = await browser(run, 'events', { after: args.after }, signal)
            matched = Array.isArray(response.events) && response.events.some((value) => {
              const event = gameRecord(value); return event.node === args.node_path && event.signal === args.signal
            })
            if (matched) break
            await delay(50, undefined, { signal })
          } while (Date.now() < deadline)
          result = { matched, timed_out: !matched }
        }
        else if (operation === 'test' || operation === 'replay') result = await runTest(run, gameString(args.test_file), signal, operation === 'replay')
        else if (operation === 'record') {
          if (args.action === 'start') {
            if (run.recording !== undefined) throw new Error('A recording is already active; stop it first')
            run.recording = { steps: [], overflow: false }
            result = { recording: true, scope: 'Tool actions only; add game_assert to verify replay; recreate starting state before replay' }
          } else if (args.action === 'stop') {
            const recording = run.recording
            if (recording === undefined) throw new Error('No active recording')
            const path = join(run.artifacts, `recording-${randomUUID()}.yaml`)
            await writeFile(path, dump({ name: 'Recorded browser game actions', incomplete_recording: recording.overflow, steps: recording.steps }), { flag: 'wx', mode: 0o600 })
            run.recording = undefined
            result = { recording: false, path, steps: recording.steps.length, truncated: recording.overflow, deterministic: false }
          } else throw new Error('Recording action must be start or stop')
        }
        else if (operation === 'tree') {
          if (args.check_source !== undefined && typeof args.check_source !== 'boolean') throw new Error('check_source must be a boolean')
          const { check_source: checkSource = true, ...treeArgs } = args
          let freshness: Record<string, unknown> = { status: 'not_checked' }
          if (checkSource) {
            try {
              const changed = await gameFingerprint(run.project, signal) !== run.fingerprint
              freshness = { status: changed ? 'changed' : 'unchanged', checked_at: new Date().toISOString(), comparison: 'content_sha256', scope: 'staged_project_files', runtime_impact: 'unknown', atomic: false,
                ...(changed ? { next_action: 'Project content changed since this preview was built, including possible test manifests or documentation. This comparison does not determine runtime impact. If only test instructions changed and those files are not used by the running game, continue testing the existing preview; call game_start when game changes must be included. This tree describes the existing preview.' } : {}) }
            } catch (error) {
              signal.throwIfAborted()
              freshness = { status: 'unknown', checked_at: new Date().toISOString(), atomic: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }
            }
          }
          result = { ...await browser(run, operation, treeArgs, signal), run_id: run.id, source_freshness: freshness }
        }
        else if (operation === 'step') result = await advance(run, args, signal)
        else result = await browser(run, operation, args, signal)
        if (run.recording !== undefined) {
          let step: Record<string, unknown> | undefined
          if (operation === 'keys') step = { keys: args.keys, duration_ms: args.duration_ms ?? 80 }
          else if (operation === 'key') step = { key: args.key, duration_ms: args.duration_ms ?? 80 }
          else if (operation === 'click') step = { click: { x: args.x, y: args.y } }
          else if (operation === 'click_ui') step = { click_ui: args.node_path }
          else if (operation === 'assert') step = { assert: { node: args.node_path, property: args.property, operator: args.operator, expected: JSON.parse(gameString(args.expected)) as unknown }, ...(args.timeout_ms === undefined ? {} : { timeout_ms: args.timeout_ms }) }
          else if (operation === 'watch') step = { watch_signal: { node: args.node_path, signal: args.signal } }
          else if (operation === 'wait_signal') step = { wait_signal: { node: args.node_path, signal: args.signal }, timeout_ms: 10000 }
          else if (operation === 'freeze' || operation === 'thaw') step = { [operation]: true }
          else if (operation === 'step') step = { step: args.frames, ...(args.clock === undefined ? {} : { clock: args.clock }) }
          else if (operation === 'screenshot') step = { screenshot: 'Recorded screenshot' }
          if (step !== undefined) {
            if (run.recording.steps.length < 100 && Buffer.byteLength(dump({ name: 'Recorded browser game actions', incomplete_recording: false, steps: [...run.recording.steps, step] })) <= 65536) run.recording.steps.push(step)
            else run.recording.overflow = true
          }
        }
        return JSON.stringify(result)
      } finally { if (runs.has(sessionId)) touch(run) }
    })
  }
  ctx.effect(() => async () => { disposal.abort(); await tail; await Promise.allSettled([...runs.values()].map(stop)) })
  ctx.systemPrompt.section({ name: 'product-game-validation', order: 101,
    text: 'Validate Godot games in the Desktop right-side browser with game_start (absolute project, optional scene), then game_tree, game_screenshot, game_key, game_click_ui, game_state and game_assert. game_logs reads bounded game stdout; game_errors reads stderr/runtime errors. Prepare load_godot_runtime(export_templates=true) first. Calls reuse the same page. game_start restarts or switches scenes without building when project content is unchanged; changed content rebuilds the resource pack and restarts the Web instance. game_stop clears the cached build. game_test reads a project-local YAML file: name and steps (click_ui path; key or keys array plus duration_ms; assert {node, property, operator, expected}; watch_signal {node,signal} BEFORE input then wait_signal; wait_node; screenshot label; wait_ms; freeze true; thaw true; step frames with optional clock: physics). YAML assert.expected uses native values: expected: 3, expected: true, or expected: menu; do not JSON-encode them as strings as required by the separate game_assert tool. YAML key: ArrowRight and duration_ms: 200 are sibling fields in one step, not a nested key object. game_key/game_keys and YAML key/keys use physical browser keys such as ArrowRight, w, Space or Enter, not InputMap action names such as ui_right. game_reproduce actions_down/actions_up use InputMap action names. Coordinates for game_click are browser CSS pixels. A delivered input or screenshot is not a passed test. The game keeps running during model reasoning and between tool calls. Before diagnosing input or focus, inspect actual gameplay state (menu, game over, paused, or running). Put timing-sensitive start/input/assert actions in one game_test sequence to avoid delays between model requests. Use assertions and game_errors. game_record start/stop saves tool actions as reviewable YAML; game_replay runs it against current state, with input-only replay marked unverified. Restore the starting state first; recordings do not capture manual input or model delays. game_freeze/game_step affect pausable nodes only, not deterministic simulation. game_stop releases the page; idle checks clean up closed, navigated or crashed pages; an open game remains available for manual play. No MCP or Godot editor plugins. Test copies contain a temporary runtime Autoload; source projects stay unchanged.',
  })
  const string = { type: 'string', required: true } as const
  const output = { schema: { type: 'string' }, render: (_args: object, value: string) => {
    const parsed = gameRecord(JSON.parse(value))
    if (parsed.image !== undefined) {
      const image = gameRecord(parsed.image)
      // The attachment service may normalize PNG bytes to JPEG/WebP. Its reference is authoritative.
      const mediaType = image.mediaType
      if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif') {
        throw new Error('Invalid normalized screenshot media type')
      }
      const attachment: ImageAttachmentRef = {
        ...image, attachmentId: AttachmentId(gameString(image.attachmentId)), mediaType,
        bytes: Number(image.bytes), width: Number(image.width), height: Number(image.height),
      }
      const { image: _image, ...metadata } = parsed
      return [{ type: 'text' as const, text: JSON.stringify(metadata) }, { type: 'image' as const, attachment }]
    }
    return [{ type: 'text' as const, text: value }]
  } } as const
  const call = (operation: string) => (args: Record<string, unknown>, exec: ToolExecution) => execute(operation, args, exec)
  const presentCall = () => ({ card: 'generic' as const, title: 'Test browser game', kind: 'read' as const })
  ctx.tools.register(defineTool({ name: 'game_start', description: 'Run a .tscn in the right-side browser. Unchanged project reuses the page and switches/restarts its scene; changed files rebuild resources. First start prepares Web runtime. game_stop clears cache. Prepare engine/templates first.', parameters: { project: string, scene: { type: 'string' } }, output, presentCall, timeoutMs: config.buildMs, execute: call('start') }))
  for (const operation of ['stop', 'screenshot', 'ui', 'logs', 'errors', 'freeze', 'thaw', 'metrics'] as const) ctx.tools.register(defineTool({ name: `game_${operation}`, description: `Browser game ${operation}. Uses this task's existing run. Freeze/thaw control pausable nodes only.`, parameters: {}, output, presentCall, execute: call(operation) }))
  ctx.tools.register(defineTool({ name: 'game_key', description: 'Send a physical browser key (e.g. ArrowRight, w, Space, Enter), NOT an InputMap action name such as ui_right. Always releases it. duration_ms is 0..10000. Delivery does not prove game effect. The game continues between calls: inspect menu/game-over/paused state before diagnosing input; use one game_test sequence for timing-sensitive start/input/assert.', parameters: { key: { ...string, description: 'Physical browser key, e.g. ArrowRight, w, Space, Enter. InputMap actions like ui_right are not keys.' }, duration_ms: { type: 'integer' } }, output, presentCall, execute: call('key') }))
  ctx.tools.register(defineTool({ name: 'game_keys',
    description: 'Hold 1..8 physical browser keys together, e.g. keys=["w","Space"] to move and jump. NOT InputMap action names. Validates all keys before input; releases all keys after duration or cancellation. duration_ms is an integer 0..10000 (default 80). Duplicate keys/aliases are rejected. Delivery does not prove game effect; inspect state and assert the result.',
    parameters: { keys: { type: 'array', required: true, items: { type: 'string' }, description: '1..8 distinct physical browser keys, e.g. w and Space.' }, duration_ms: { type: 'integer' } },
    output, presentCall, execute: call('keys'),
  }))
  ctx.tools.register(defineTool({ name: 'game_click', description: 'Click the current game at browser CSS pixel coordinates.', parameters: { x: { type: 'number', required: true }, y: { type: 'number', required: true } }, output, presentCall, execute: call('click') }))
  ctx.tools.register(defineTool({ name: 'game_click_ui', description: 'Find a visible Godot Control and send a browser click at its center; inspect/assert the effect.', parameters: { node_path: string }, output, presentCall, execute: call('click_ui') }))
  ctx.tools.register(defineTool({ name: 'game_tree', description: 'Inspect the live scene structure including non-UI nodes, script and scene paths. Optional absolute node_path defaults to /root; depth 0..32 defaults to 8, limit 1..500 defaults to 200. A truncated result can be explored by subtree. check_source defaults to true: compare source content with the current preview and report changed/unchanged/unknown; false skips hashing. The comparison includes test manifests and documentation and does not determine runtime impact. Test instruction edits can use the existing preview only when those files are not used by the running game; use game_start when game changes must be included. The comparison is not an atomic snapshot.', parameters: { check_source: { type: 'boolean' }, node_path: { type: 'string' }, depth: { type: 'integer' }, limit: { type: 'integer' } }, output, presentCall, execute: call('tree') }))
  ctx.tools.register(defineTool({ name: 'game_state', description: 'Read one node property; nested components use position.x. Without property returns node identity.', parameters: { node_path: string, property: { type: 'string' } }, output, presentCall, execute: call('state') }))
  ctx.tools.register(defineTool({ name: 'game_assert', description: 'Compare an observed node property. expected is one JSON literal (number, boolean or quoted string). Returns passed and actual. Optional timeout_ms (integer 0..10000, default 0) polls only state every 100ms; eventual success means observed within the window, not immediate success or event latency.', parameters: { node_path: string, property: string, operator: { ...string, enum: ['==', '!=', '>', '>=', '<', '<='] }, expected: string, timeout_ms: { type: 'integer' } }, output, presentCall, execute: call('assert') }))
  ctx.tools.register(defineTool({ name: 'game_step', description: 'Advance 1..120 frames after game_freeze. clock defaults to process; physics advances exact pausable physics ticks including solver steps. Process callbacks can also run. Returns paused; ALWAYS nodes remain active. Not global determinism.', parameters: { frames: { type: 'integer', required: true }, clock: { type: 'string', enum: ['process', 'physics'] } }, output, presentCall, execute: call('step') }))
  ctx.tools.register(defineTool({ name: 'game_watch_signal', description: 'Subscribe BEFORE input; returns a cursor for game_wait_signal. Captures occurrence, not signal arguments.', parameters: { node_path: string, signal: string }, output, presentCall, execute: call('watch') }))
  ctx.tools.register(defineTool({ name: 'game_wait_signal', description: 'Wait up to 10 seconds for a previously subscribed signal after its cursor; returns matched or timed_out. Subscribe before input.', parameters: { node_path: string, signal: string, after: { type: 'integer', required: true } }, output, presentCall, execute: call('wait_signal') }))
  ctx.tools.register(defineTool({ name: 'game_record', description: 'Start/stop recording successful tool keyboard, click, assertion, signal, screenshot and frame actions to reviewable project-local YAML (max 100 steps). Does not record manual user input, delays between calls or restore state. Stop recording before restarting/stopping the run.', parameters: { action: { ...string, enum: ['start', 'stop'] } }, output, presentCall, execute: call('record') }))
  ctx.tools.register(defineTool({ name: 'game_reproduce', description: 'Compare two isolated cold Web runs of the current stable game_start build using a project-local reproduction manifest. Requires reset_node._opengame_reset(seed) synchronously returning true and resetting project RNGs, Autoloads and startup side effects. YAML/JSON example: {version: 1, seed: 123, reset_node: /root/Main, observations: [{node: /root/Main/Player, property: position.x}], steps: [{actions_down: [ui_right], physics_ticks: 30}, {actions_up: [ui_right], physics_ticks: 1}]}. Fields are exact: version=1; seed integer 0..2147483647; observations 1..32 node/property pairs; steps 1..100 with optional actions_down/actions_up arrays (combined <=16 unique nonempty names, no overlap) and required physics_ticks 1..120, total <=1200. At least one action is required; all actions must exist. File <=64KiB; unknown fields rejected. Trace observes reset state and each segment endpoint, bridge trace <=100KiB; excess fails, never truncates. Physics-tick actions and declared observations only; not global determinism. Returns summary and full report path. Stop recording first; changed source/runtime requires game_start again.', parameters: { test_file: string }, output, presentCall, timeoutMs: 300_000, execute: call('reproduce') }))
  ctx.tools.register(defineTool({ name: 'game_replay', description: 'Replay recorded YAML through the same ordered test runner against current game state. Recreate starting state first. Input-only replay returns unverified; assertions/observed conditions are required for passed. No strict determinism or snapshot restore.', parameters: { test_file: string }, output, presentCall, timeoutMs: 120_000, execute: call('replay') }))
  ctx.tools.register(defineTool({ name: 'game_test', description: 'Execute project-local YAML name/steps in order. YAML assert.expected is a native scalar: expected: 3, expected: true, or expected: menu; unlike game_assert, do not JSON-encode the value as text. key and duration_ms are sibling step fields, not a nested key object. Example (replace node paths and expected values for your game):\nname: movement\nsteps:\n  - key: ArrowRight\n    duration_ms: 200\n  - assert: {node: /root/Main/Player, property: position.x, operator: ">", expected: 10}\nSupports key, click, click_ui, assert, wait_node, watch_signal then wait_signal, screenshot, wait_ms, freeze, thaw, step with optional clock: physics. Returns passed/failed/incomplete and evidence report. Group timing-sensitive start/input/assert here because the game keeps running during model reasoning between separate calls.', parameters: { test_file: string }, output, presentCall, timeoutMs: 120_000, execute: call('test') }))
}
