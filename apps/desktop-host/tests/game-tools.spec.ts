import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { registerGameValidation, inject, type Config } from '../src/game-validation.ts'
import { gameRecord, gameString } from '../src/game-tests.ts'
import { stageGame } from '../src/game-build.ts'

const available = process.platform === 'darwin' && await access('/Applications/Godot.app').then(() => true, () => false)
it.skipIf(!available)('loads tools through Loader, builds once, executes assertions and reports failures without modifying source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'game-tools-'))
  const ctx = new Context()
  const commands: string[] = []
  let attached = true
  let playing = false, position = 50, cursor = 0
  const chords: Record<string, unknown>[] = []
  const stepArgs: Record<string, unknown>[] = []
  let isolated = true, reproductionMode = 'match', reproductionTrial = 0
  let failGuestCleanup = false
  let reproductionCancel: AbortController | undefined
  let reproductionMutation: (() => Promise<void>) | undefined
  const isolatedRuns: string[] = [], stoppedRuns: string[] = []
  let failStep = false
  let cancelStep: AbortController | undefined
  const browser = async (operation: string, args: Record<string, unknown>, signal: AbortSignal) => {
    commands.push(operation)
    switch (operation) {
      case 'lifecycle': return { attached }
      case 'scene': return { scene_ready: true }
      case 'open':
        if (args.isolation === true) isolatedRuns.push(String(args.runId))
        return { ready: true, ...(args.isolation === true ? { isolated } : {}) }
      case 'reproduce':
        reproductionTrial++
        if (reproductionCancel !== undefined) { reproductionCancel.abort(); signal.throwIfAborted() }
        if (reproductionMutation !== undefined) await reproductionMutation()
        if (reproductionMode === 'reset') return { error: 'Missing _opengame_reset' }
        return { trace: [{ tick: 0, values: [0] }, { tick: 2, values: [reproductionMode === 'differ' ? reproductionTrial : 2] }], physics: reproductionMode === 'physics' ? { legacy: true } : { ticks_per_second: 60, max_steps_per_frame: 8, time_scale: 1 } }
      case 'watch': return { cursor }
      case 'click_ui': playing = true; cursor++; return { delivered: true }
      case 'keys': chords.push(args); return { delivered: true }
      case 'key': position += 100; return { delivered: true }
      case 'state': return { value: position }
      case 'events': return { cursor, events: [{ node: '/root/Main', signal: 'started', sequence: cursor }] }
      case 'screenshot': return { png: (await readFile(join(import.meta.dirname, '../../desktop/resources/icon.png'))).toString('base64') }
      case 'tree': return { nodes: [{ path: '/root/Main', type: 'Control' }], truncated: false }
      case 'logs': return { logs: ['fixture log'] }
      case 'freeze': case 'thaw': return { frozen: operation === 'freeze' }
      case 'step':
        stepArgs.push(args)
        if (cancelStep !== undefined) { cancelStep.abort(); signal.throwIfAborted() }
        if (failStep) throw new Error('Simulated interrupted step')
        return { observed_process_frames: 3, deterministic: false }
      case 'errors': return { errors: reproductionMode === 'errors' ? ['fixture runtime error'] : [] }
      case 'stop':
        stoppedRuns.push(String(args.runId))
        if (failGuestCleanup && isolatedRuns.includes(String(args.runId))) throw new Error('Fixture cleanup failed')
        return { stopped: true }
      default: throw new Error('Unexpected browser operation: ' + operation)
    }
  }
  try {
    const project = join(root, 'source')
    await stageGame(join(import.meta.dirname, '../../desktop/tests/fixtures/browser-game'), project, new AbortController().signal)
    await mkdir(join(root, 'dependencies/node/bin'), { recursive: true }); await symlink(process.execPath, join(root, 'dependencies/node/bin/node'))
    await mkdir(join(root, 'engine')); await symlink('/Applications/Godot.app', join(root, 'engine/Godot.app')); await writeFile(join(root, 'engine/installed.json'), '{}')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, tools: ToolRuntime, system: SystemPrompt, policy: SandboxPolicy,
      projections: SessionProjections, sandbox: LocalSandbox, subprocess: LocalSubprocess, attachments: LocalAttachments,
      game: { inject, apply: (scope: Context, config: Config) =>{  registerGameValidation(scope, config, browser) } } })
    const configFile = join(root, 'cordis.yml')
    await writeFile(configFile, ['- name: cordis:system', '- name: cordis:tools', '- name: cordis:projections', '- name: cordis:policy', '  config:', '    mode: danger-full-access', `    workspaceRoot: ${JSON.stringify(project)}`, '- name: cordis:sandbox', '- name: cordis:subprocess', '- name: cordis:attachments', '  config:', `    dshHome: ${JSON.stringify(root)}`, '    normalizedImageMaxDimension: 32', '- name: cordis:game', '  config:', `    root: ${JSON.stringify(root)}`, `    resources: ${JSON.stringify(join(import.meta.dirname, '../../desktop/resources/godot'))}`, `    primaryRuntime: ${JSON.stringify(root)}`, '    buildMs: 60000', '    operationMs: 5000', '    idleMs: 200', ''].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configFile).href } }); await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(ctx.tools.get('game_key')!.description).toContain('inspect menu/game-over/paused state')
    expect(ctx.tools.get('game_test')!.description).toContain('game keeps running during model reasoning')
    // The authoritative attachment can change codec and dimensions during normalization.
    const normalized = await ctx.attachments.saveImage({
      data: await readFile(join(import.meta.dirname, '../../desktop/resources/icon.png')), mediaType: 'image/png', name: 'game.png',
    })
    expect(normalized.mediaType).not.toBe('image/png')
    const imageBlocks = ctx.tools.get('game_screenshot')!.output.render({}, JSON.stringify({ path: '/source-evidence.png', image: normalized, captured_at: '2026-10-13T00:00:00.000Z', temporal_context: 'Saved historical screenshot' }))
    const imageBlock = imageBlocks.find(block => block.type === 'image')
    if (imageBlock?.type !== 'image') throw new Error('Expected screenshot attachment')
    const metadataBlock = imageBlocks[0]
    if (metadataBlock?.type !== 'text') throw new Error('Expected screenshot metadata')
    expect(metadataBlock.text).toContain('Saved historical screenshot')
    expect(metadataBlock.text).toContain('2026-10-13T00:00:00.000Z')
    expect(imageBlock.attachment).toEqual(normalized)
    await expect(ctx.attachments.readImage(imageBlock.attachment)).resolves.toMatchObject({ ref: normalized })
    const session = Session.create(SessionId('game-task'))
    const agent = { id: session.id, session, options: {} } as Agent
    let id = 0
    const call = (name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) => ctx.tools.execute({
      callId: ToolCallId(String(++id)), name, arguments: args, agent, signal,
    })
    const value = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await call(name, args)
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      const block = result.content[0]; if (block?.type !== 'text') throw new Error('Expected text')
      return gameRecord(JSON.parse(block.text))
    }
    expect((await call('game_ui')).isError).toBe(true)
    const beforeMissingProject = commands.length
    expect((await call('game_start')).isError).toBe(true)
    const relativeProject = await call('game_start', { project: '.' })
    expect(relativeProject.isError).toBe(true)
    expect(JSON.stringify(relativeProject.content)).toContain('absolute directory path')
    expect(commands).toHaveLength(beforeMissingProject)
    const started = await value('game_start', { project })
    expect(started.build).toBe('full')
    const freshTree = await value('game_tree')
    expect(freshTree.run_id).toBe(started.runId)
    expect(gameRecord(freshTree.source_freshness).status).toBe('unchanged')
    await writeFile(join(project, 'freshness-check.yaml'), 'changed')
    const changedTree = await value('game_tree')
    expect(gameRecord(changedTree.source_freshness).status).toBe('changed')
    expect(gameRecord(changedTree.source_freshness).scope).toBe('staged_project_files')
    expect(gameRecord(changedTree.source_freshness).runtime_impact).toBe('unknown')
    expect(gameRecord(changedTree.source_freshness).next_action).toContain('If only test instructions changed and those files are not used by the running game, continue testing the existing preview')
    expect(gameRecord(changedTree.source_freshness).next_action).toContain('game_start')
    await rm(join(project, 'freshness-check.yaml'))
    expect(gameRecord((await value('game_tree')).source_freshness).status).toBe('unchanged')
    await symlink(join(project, 'main.gd'), join(project, 'freshness-link'))
    expect(gameRecord((await value('game_tree')).source_freshness).status).toBe('unknown')
    expect(gameRecord((await value('game_tree', { check_source: false })).source_freshness).status).toBe('not_checked')
    // Input does not fingerprint: the same symlink would make a hash fail.
    expect((await value('game_key', { key: 'ArrowRight' })).delivered).toBe(true)
    position -= 100
    await rm(join(project, 'freshness-link'))
    const cancelledTree = new AbortController(); cancelledTree.abort()
    expect((await call('game_tree', {}, cancelledTree.signal)).isError).toBe(true)


    const reused = await value('game_start', { project, scene: 'res://main.tscn' })
    expect(reused.build).toBe('reused'); expect(reused.runId).toBe(started.runId)
    expect(commands.filter(command => command === 'open')).toHaveLength(1)
    const original = await readFile(join(project, 'project.godot'), 'utf8')
    expect(original).not.toContain('OpenGameTest')
    await writeFile(join(project, 'invalid.yaml'), 'name: Invalid\nsteps:\n - click_ui: /root/Main/StartButton\n - wait_signal: {node: /root/Main, signal: started}\n')
    const beforeInvalid = commands.length
    expect((await call('game_test', { test_file: 'invalid.yaml' })).isError).toBe(true)
    expect(commands).toHaveLength(beforeInvalid)
    await writeFile(join(project, 'test.yaml'), 'name: Move\nsteps:\n - watch_signal: {node: /root/Main, signal: started}\n - click_ui: /root/Main/StartButton\n - wait_signal: {node: /root/Main, signal: started}\n - key: ArrowRight\n   duration_ms: 100\n - assert: {node: /root/Main/Player, property: position.x, operator: ">", expected: 80}\n')
    const passed = await value('game_test', { test_file: 'test.yaml' })
    expect(passed.status).toBe('passed'); expect(playing).toBe(true)
    expect(commands.filter(command => command === 'open')).toHaveLength(1)
    expect(commands.indexOf('watch')).toBeLessThan(commands.indexOf('click_ui'))
    const screenshotResult = await call('game_screenshot')
    expect(screenshotResult.content.some(block => block.type === 'image')).toBe(false)
    const savedScreenshot = await value('game_screenshot')
    expect(savedScreenshot.visual_verified).toBe(false)
    expect(savedScreenshot.image_attached).toBe(false)
    expect(Number.isFinite(Date.parse(gameString(savedScreenshot.captured_at)))).toBe(true)
    expect(savedScreenshot.temporal_context).toContain('not the same snapshot')
    const observedTree = await value('game_tree')
    expect(Date.parse(gameString(observedTree.observed_at))).toBeGreaterThanOrEqual(Date.parse(gameString(savedScreenshot.captured_at)))
    expect(observedTree.observation_clock).toContain('not an exact engine frame')
    await access(gameString(savedScreenshot.path))
    expect((await value('game_tree')).truncated).toBe(false)
    expect((await value('game_logs')).logs).toEqual(['fixture log'])
    await value('game_record', { action: 'start' })
    expect((await call('game_stop')).isError).toBe(true)
    const recordedWatch = await value('game_watch_signal', { node_path: '/root/Main', signal: 'started' })
    await value('game_click_ui', { node_path: '/root/Main/StartButton' })
    await value('game_wait_signal', { node_path: '/root/Main', signal: 'started', after: recordedWatch.cursor })
    await value('game_assert', { node_path: '/root/Main/Player', property: 'position.x', operator: '>', expected: '80', timeout_ms: 500 })
    await value('game_freeze')
    await value('game_step', { frames: 2, clock: 'physics' })
    const beforeInvalidChord = commands.length
    expect((await call('game_keys', { keys: ['w', 'w'] })).isError).toBe(true)
    expect(commands.length).toBe(beforeInvalidChord)
    await value('game_keys', { keys: ['w', 'Space'], duration_ms: 200 })
    const recording = await value('game_record', { action: 'stop' })
    expect(recording.steps).toBe(7)
    expect(await readFile(gameString(recording.path), 'utf8')).toContain('click_ui: /root/Main/StartButton')
    expect(await readFile(gameString(recording.path), 'utf8')).toContain('timeout_ms: 10000')
    expect(await readFile(gameString(recording.path), 'utf8')).toContain('timeout_ms: 500')
    expect((await value('game_replay', { test_file: recording.path })).status).toBe('passed')
    expect(chords).toHaveLength(2)
    expect(chords.every(args => JSON.stringify(args.keys) === JSON.stringify(['w', 'Space']) && args.duration_ms === 200)).toBe(true)
    expect(stepArgs).toHaveLength(2)
    expect(stepArgs.every(args => args.clock === 'physics' && args.frames === 2)).toBe(true)
    expect(await readFile(gameString(recording.path), 'utf8')).toContain('clock: physics')
    failStep = true
    expect((await call('game_step', { frames: 120, clock: 'physics' })).isError).toBe(true)
    expect(commands.at(-1)).toBe('freeze')
    failStep = false
    cancelStep = new AbortController()
    expect((await call('game_step', { frames: 120, clock: 'physics' }, cancelStep.signal)).isError).toBe(true)
    expect(commands.at(-1)).toBe('freeze')
    cancelStep = undefined
    await value('game_record', { action: 'start' })
    await value('game_click_ui', { node_path: '/root/Main/StartButton' })
    const inputOnly = await value('game_record', { action: 'stop' })
    expect((await value('game_replay', { test_file: inputOnly.path })).status).toBe('unverified')
    expect((await call('game_test', { test_file: inputOnly.path })).isError).toBe(true)

    const failed = await value('game_assert', { node_path: '/root/Main/Player', property: 'position.x', operator: '<', expected: '0' })
    expect(failed.passed).toBe(false); expect(failed.actual).toBe(150)
    expect(failed.status).toBe('failed'); expect(failed.operator).toBe('<')
    expect(failed.next_action).toContain('do not report')
    await writeFile(join(project, 'test.yaml'), 'name: Fail\nsteps:\n - assert: {node: /root/Main/Player, property: position.x, operator: "<", expected: 0}\n')
    const report = await value('game_test', { test_file: 'test.yaml' })
    expect(report.status).toBe('failed')
    expect(report.temporal_context).toContain('not one atomic snapshot')
    expect(report.visual_verified).toBe(false)
    expect(report.evidence_paths).toEqual([expect.stringMatching(/screenshot-.*\.png$/u)])
    expect(report.next_action).toContain('read_image')
    expect(report.next_action).toContain('not image input')
    expect(gameRecord(JSON.parse(await readFile(gameString(report.reportPath), 'utf8'))).status).toBe('failed')
    const refreshed = await value('game_start', { project })
    expect(refreshed.build).toBe('resources'); expect(refreshed.runId).not.toBe(started.runId)
    expect((await value('game_start', { project })).build).toBe('reused')
    const script = await readFile(join(project, 'main.gd'), 'utf8')
    await writeFile(join(project, 'main.gd'), 'invalid gdscript!')
    const brokenBuild = await call('game_start', { project })
    expect(brokenBuild.isError).toBe(true)
    const diagnostic = JSON.stringify(brokenBuild.content)
    expect(diagnostic).toContain('Source project: ' + await realpath(project))
    expect(diagnostic).toContain('res://main.gd:1')
    expect(diagnostic).toContain('godot-project check')
    expect(diagnostic).not.toContain('\\u001b')
    expect(diagnostic).toContain('previous running game is retained')
    await writeFile(join(project, 'main.gd'), script)
    expect((await value('game_start', { project })).runId).toBe(refreshed.runId)
    // A caller can remove disposable exports without changing source content.
    for (const directory of await readdir(project)) if (directory.startsWith('.opengame-game-')) {
      await rm(join(project, directory), { recursive: true, force: true })
    }
    const recovered = await value('game_start', { project })
    expect(recovered.build).toBe('full'); expect(recovered.cache_recovered).toBe(true)
    expect(recovered.runId).not.toBe(refreshed.runId)
    expect((await value('game_start', { project })).build).toBe('reused')
    // Partial cache loss plus a source edit must also avoid the old runtime-copy path.
    const cache = (await readdir(project)).find(directory => directory.startsWith('.opengame-game-'))!
    await rm(join(project, cache, 'web/index.wasm'))
    await writeFile(join(project, 'main.gd'), script + '\n# cache recovery source edit\n')
    const partialRecovered = await value('game_start', { project })
    expect(partialRecovered.build).toBe('full'); expect(partialRecovered.cache_recovered).toBe(true)
    const lastCache = (await readdir(project)).find(directory => directory.startsWith('.opengame-game-'))!
    await rm(join(project, lastCache), { recursive: true, force: true })
    await writeFile(join(project, 'main.gd'), 'THIS IS NOT GDSCRIPT\n')
    const failedRecovery = await call('game_start', { project })
    expect(failedRecovery.isError).toBe(true)
    const failedRecoveryText = JSON.stringify(failedRecovery.content)
    expect(failedRecoveryText).toContain('Previous preview cache was missing and could not be retained')
    expect(failedRecoveryText).not.toContain('A previous running game is retained')
    await writeFile(join(project, 'main.gd'), script)
    expect((await value('game_start', { project })).build).toBe('full')
    await writeFile(join(project, '.reproduce.json'), JSON.stringify({ version: 1, seed: 1, reset_node: '/root/Main', observations: [{ node: '/root/Main', property: 'score' }], steps: [{ actions_down: ['ui_right'], physics_ticks: 2 }] }))
    const reproduction = await value('game_reproduce', { test_file: '.reproduce.json' })
    expect(reproduction.reproducibility_verified).toBe(true)
    expect(reproduction).not.toHaveProperty('traces')
    const saved = JSON.parse(await readFile(String(reproduction.reportPath), 'utf8')) as { trials: unknown[] }
    expect(saved.trials).toHaveLength(2)
    expect(new Set(isolatedRuns).size).toBe(2)
    expect(isolatedRuns.every(runId => stoppedRuns.includes(runId))).toBe(true)
    isolated = false
    expect((await call('game_reproduce', { test_file: '.reproduce.json' })).isError).toBe(true)
    expect(stoppedRuns).toContain(isolatedRuns.at(-1))
    isolated = true; reproductionMode = 'differ'
    expect((await value('game_reproduce', { test_file: '.reproduce.json' })).reproducibility_verified).toBe(false)
    reproductionMode = 'physics'
    expect(JSON.stringify((await call('game_reproduce', { test_file: '.reproduce.json' })).content)).toContain('physics configuration')
    reproductionMode = 'errors'
    expect(JSON.stringify((await call('game_reproduce', { test_file: '.reproduce.json' })).content)).toContain('runtime errors')
    reproductionMode = 'reset'
    const missingReset = await call('game_reproduce', { test_file: '.reproduce.json' })
    expect(JSON.stringify(missingReset.content)).toContain('_opengame_reset')
    expect(JSON.stringify(missingReset.content)).toContain('Partial reproduction report:')
    failGuestCleanup = true
    expect(JSON.stringify((await call('game_reproduce', { test_file: '.reproduce.json' })).content)).toContain('_opengame_reset')
    failGuestCleanup = false
    reproductionMode = 'match'
    await value('game_record', { action: 'start' })
    expect((await call('game_reproduce', { test_file: '.reproduce.json' })).isError).toBe(true)
    await value('game_record', { action: 'stop' })
    reproductionCancel = new AbortController()
    expect((await call('game_reproduce', { test_file: '.reproduce.json' }, reproductionCancel.signal)).isError).toBe(true)
    expect(stoppedRuns).toContain(isolatedRuns.at(-1))
    reproductionCancel = undefined
    reproductionMutation = async () => { await writeFile(join(project, 'main.gd'), script + '\n# modified in reproduction\n') }
    expect(JSON.stringify((await call('game_reproduce', { test_file: '.reproduce.json' })).content)).toContain('changed')
    reproductionMutation = undefined
    await writeFile(join(project, 'main.gd'), script)
    expect((await value('game_start', { project })).build).toBe('reused')
    const stops = commands.filter(command => command === 'stop').length
    await new Promise(resolve => setTimeout(resolve, 550))
    expect(commands).toContain('lifecycle')
    expect(commands.filter(command => command === 'stop')).toHaveLength(stops)
    attached = false
    await expect.poll(() => commands.filter(command => command === 'stop').length).toBe(stops + 1)
    await expect.poll(async () => (await readdir(project)).some(name => name.startsWith('.opengame-game-'))).toBe(false)
    expect((await readdir(project)).some(name => name.startsWith('.opengame-game-'))).toBe(false)
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(original)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 90000)
