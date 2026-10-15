import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gameFingerprint, stageGame, installGameHarness, serveGame } from '../src/game-build.ts'
import { gameCompare, parseGameTest } from '../src/game-tests.ts'

it('stages without altering source and serves only exported artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'game-build-'))
  let server: Awaited<ReturnType<typeof serveGame>> | undefined
  try {
    const project = join(root, 'source'), copy = join(root, 'copy'), exported = join(root, 'web')
    await mkdir(project); await mkdir(exported)
    await writeFile(join(project, 'project.godot'), '[application]\nconfig/name="Game"\n')
    await mkdir(join(project, '.git')); await writeFile(join(project, '.git/config'), 'private')
    await stageGame(project, copy, new AbortController().signal)
    await installGameHarness(copy, join(import.meta.dirname, '../../desktop/resources/godot'))
    expect(await readFile(join(project, 'project.godot'), 'utf8')).not.toContain('OpenGameTest')
    await expect(readFile(join(copy, '.git/config'))).rejects.toThrow()
    expect(await readFile(join(copy, 'export_presets.cfg'), 'utf8')).toContain('variant/thread_support=false')
    await writeFile(join(exported, 'index.html'), '<canvas></canvas>')
    await writeFile(join(exported, 'game.wasm'), 'wasm')
    server = await serveGame(exported, 'test-run')
    expect(await (await fetch(server.url)).text()).toBe('<canvas></canvas>')
    expect((await fetch(server.url.replace('index.html', 'game.wasm'))).headers.get('content-type')).toBe('application/wasm')
    expect((await fetch(server.url.replace('index.html', '%2e%2e%2fsource%2fproject.godot'))).status).not.toBe(200)
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(405)
    await symlink(join(project, 'project.godot'), join(exported, 'linked'))
    expect((await fetch(server.url.replace('index.html', 'linked'))).status).toBe(403)
    await symlink(join(root, 'outside'), join(project, 'escape'))
    await expect(stageGame(project, join(root, 'refuse'), new AbortController().signal)).rejects.toThrow('symlinks')
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }) }
})

it('validates complete test steps before execution and compares observed values', () => {
  expect(parseGameTest('name: move\nsteps:\n - key: ArrowRight\n   duration_ms: 200\n - assert: {node: /root/Player, property: position.x, operator: ">", expected: 10}').steps).toHaveLength(2)
  expect(() => parseGameTest('name: invalid\nsteps:\n - key: Right\n   click_ui: /root/Button')).toThrow('one command')
  expect(() => parseGameTest('name: invalid\nsteps:\n - key: Right\n   duration_ms: 999999')).toThrow('0..10000')
  expect(() => parseGameTest('name: invalid\nsteps:\n - eval: malicious')).toThrow()
  expect(() => parseGameTest('name: invalid\nsteps:\n - action: game_key\n   args: {key: Right}')).toThrow('Use YAML command keys directly')
  expect(() => parseGameTest('name: incomplete\nsteps:\n - screenshot: done')).toThrow('cannot pass')
  expect(gameCompare(20, '>', 10)).toBe(true)
  expect(gameCompare(false, '==', true)).toBe(false)
  expect(() => gameCompare('20', '>', 10)).toThrow('numbers')
})

it('invalidates content changes, additions and removals but ignores generated evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'game-digest-'))
  const signal = new AbortController().signal
  try {
    await writeFile(join(root, 'main.tscn'), 'first')
    const first = await gameFingerprint(root, signal)
    await mkdir(join(root, '.opengame-test-results'))
    await writeFile(join(root, '.opengame-test-results/result.json'), 'evidence')
    expect(await gameFingerprint(root, signal)).toBe(first)
    await writeFile(join(root, 'main.tscn'), 'other')
    expect(await gameFingerprint(root, signal)).not.toBe(first)
    await writeFile(join(root, 'main.tscn'), 'first')
    await writeFile(join(root, 'new.tscn'), 'scene')
    expect(await gameFingerprint(root, signal)).not.toBe(first)
    await rm(join(root, 'new.tscn'))
    expect(await gameFingerprint(root, signal)).toBe(first)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects invalid later conditions before a test can deliver any input', () => {
  const input = 'name: preflight\nsteps:\n - click_ui: /root/Button\n'
  expect(() => parseGameTest(input + ' - wait_signal: {node: /root/Main, signal: started}')).toThrow('watch_signal must precede')
  expect(() => parseGameTest(input + ' - assert: {node: /root/Main, property: score, operator: ">", expected: text}')).toThrow('require numbers')
  expect(() => parseGameTest(input + ' - assert: {node: /root/Main, property: score, operator: "==", expected: .inf}')).toThrow('finite')
  expect(() => parseGameTest(input + ' - wait_node: /root/Main\n   duration_ms: 10')).toThrow('duration_ms requires key')
  expect(() => parseGameTest(input + ' - assert: {node: /root/Main, property: score, operator: "==", expected: 1}\n   timeout_ms: 10001')).toThrow('timeout_ms must be 0..10000')
  expect(parseGameTest('name: valid\nsteps:\n - watch_signal: {node: /root/Main, signal: started}\n - click_ui: /root/Button\n - wait_signal: {node: /root/Main, signal: started}').steps).toHaveLength(3)
})

it('supports reviewable replay without reporting input delivery as verified success', () => {
  expect(() => parseGameTest('name: truncated\nincomplete_recording: true\nsteps:\n - click_ui: /root/Button', false)).toThrow('Recording exceeded')
  const recorded = 'name: recorded\nsteps:\n - click_ui: /root/Main/Button\n - wait_ms: 25\n - freeze: true\n - step: 3\n - thaw: true'
  expect(parseGameTest(recorded, false).steps).toHaveLength(5)
  expect(() => parseGameTest(recorded)).toThrow('cannot pass')
  expect(() => parseGameTest('name: invalid\nsteps:\n - step: 0', false)).toThrow('1..120')
  expect(() => parseGameTest('name: invalid\nsteps:\n - wait_ms: 10001', false)).toThrow('0..10000')
  expect(() => parseGameTest('name: invalid\nsteps:\n - freeze: false', false)).toThrow('must be true')
  expect(() => parseGameTest('name: invalid\nsteps:\n - click: {x: 50000, y: 1}', false)).toThrow('x/y')
})


it('reports the exact step and field for malformed YAML values without guessing a schema', () => {
  const parse = (step: string) => parseGameTest(`name: diagnostic\nsteps:\n - wait_ms: 0\n - ${step}`, false)
  for (const [value, field] of [
    ['key: {key: ArrowRight, duration_ms: 200}', 'key'],
    ['screenshot: {}', 'screenshot'], ['screenshot: ""', 'screenshot'],
    ['click_ui: null', 'click_ui'], ['wait_node: 1', 'wait_node'],
    ['click: []', 'click'], ['click: {x: nope, y: 1}', 'click.x'],
    ['watch_signal: {node: /root/Main}', 'watch_signal.signal'],
    ['wait_signal: {signal: started}', 'wait_signal.node'],
    ['assert: {node: /root/Main, property: 1}', 'assert.property'],
    ['assert: {node: /root/Main, property: score, expected: 0}', 'assert.operator'],
    ['assert: {node: /root/Main, property: score, operator: "=="}', 'assert.expected'],
    ['key: ArrowRight\n   duration_ms: fast', 'duration_ms'],
    ['freeze: false', 'freeze'], ['step: 0', 'step'],
  ]) {
    expect(() => parse(value!)).toThrow(/Test step 2:/u)
    expect(() => parse(value!)).toThrow(field!)
  }
  expect(() => parse('key: {key: ArrowRight}')).toThrow('same indentation')
  expect(() => parse('screenshot: false')).toThrow('nonempty string')
  expect(() => parseGameTest('name: []\nsteps: []')).toThrow('name: expected a nonempty string')
  expect(() => parseGameTest('name: valid\nsteps: nope')).toThrow('steps: expected an array')
  expect(() => parseGameTest('name: valid\nsteps: [null]', false)).toThrow('Test step 1: step: expected an object')
})
