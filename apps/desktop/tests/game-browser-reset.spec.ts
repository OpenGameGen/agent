import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: { on: vi.fn(), off: vi.fn() } }))
import { GameBrowser, gamePhysicalKey, gamePhysicalKeys, holdGameKeys } from '../src/product/game-browser.ts'

function fixture() {
  const send = vi.fn()
  let hostThrottling = true
  const window = { isDestroyed: vi.fn(() => false), webContents: { isDestroyed: vi.fn(() => false), send,
    getBackgroundThrottling: () => hostThrottling, setBackgroundThrottling: vi.fn((value: boolean) => { hostThrottling = value }) } }
  const browser = new GameBrowser({ releaseIsolatedGame: async () => false } as never, () => window as never)
  const state = browser as unknown as { runs: Map<string, unknown>; active: Map<string, AbortController> }
  function guest(url = 'http://127.0.0.1/game/one', destroyed = false) {
    const events = new EventEmitter()
    let throttling = true
    return { on: events.on.bind(events), off: events.off.bind(events), emit: events.emit.bind(events), listenerCount: events.listenerCount.bind(events), getBackgroundThrottling: () => throttling, setBackgroundThrottling: vi.fn((value: boolean) => { throttling = value }), isDestroyed: () => destroyed, isCrashed: vi.fn(() => false), getURL: () => url, once: events.once.bind(events), close: vi.fn(() => { destroyed = true; events.emit('destroyed') }) }
  }
  function add(id: string, current = 'http://127.0.0.1/game/one', destroyed = false) {
    const value = guest(current, destroyed)
    state.runs.set(id, { url: 'http://127.0.0.1/game/one', sessionId: 'task', guest: value })
    return value
  }
  return { browser, state, add, window, send }
}
describe('Host game reset', () => {
  it('closes exact game guests, clears run state, aborts requests and removes registered tabs', () => {
    const f = fixture(); const game = f.add('one'); const active = new AbortController(); f.state.active.set('request', active)
    f.browser.reset()
    expect(game.close).toHaveBeenCalledOnce(); expect(active.signal.aborted).toBe(true)
    expect(f.state.runs.size).toBe(0); expect(f.send).toHaveBeenCalledWith(expect.any(String), { sessionId: 'task', url: 'http://127.0.0.1/game/one' })
    f.browser.reset(); expect(f.send).toHaveBeenCalledOnce()
  })
  it('preserves a guest that navigated to an ordinary page, without removing its tab', () => {
    const f = fixture(); const page = f.add('one', 'https://example.com')
    f.browser.reset(); expect(page.close).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.state.runs.size).toBe(0)
  })
  it('removes registration for an already destroyed game', () => {
    const f = fixture(); const game = f.add('one', undefined, true)
    f.browser.reset(); expect(game.close).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce()
  })
  it.each(['window', 'webContents'])('does not send into a destroyed %s context', (target) => {
    const f = fixture(); const game = f.add('one')
    if (target === 'window') f.window.isDestroyed.mockReturnValue(true)
    else f.window.webContents.isDestroyed.mockReturnValue(true)
    f.browser.reset(); expect(game.close).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled()
  })
  it('cleans all guests even when renderer IPC send fails during shutdown', () => {
    const f = fixture(); const one = f.add('one'); const two = f.add('two')
    f.send.mockImplementation(() => { throw new Error('Render frame was disposed') })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => { f.browser.reset() }).not.toThrow()
      expect(one.close).toHaveBeenCalledOnce()
      expect(two.close).toHaveBeenCalledOnce()
      expect(f.state.runs.size).toBe(0)
      expect(warning).toHaveBeenCalledTimes(2)
    } finally { warning.mockRestore() }
  })
  it('normal stop succeeds with a closed renderer IPC context', async () => {
    const f = fixture(); const game = f.add('one'); f.window.webContents.isDestroyed.mockReturnValue(true)
    await expect(f.browser.request('req', 'stop', { runId: 'one', sessionId: 'task' })).resolves.toEqual({ stopped: true })
    expect(game.close).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled(); expect(f.state.runs.size).toBe(0)
  })
})

it('checks lifecycle without revealing, focusing or closing any page', async () => {
  const f = fixture(); const game = f.add('one')
  const args = { runId: 'one', sessionId: 'task' }
  await expect(f.browser.request('a', 'lifecycle', args)).resolves.toEqual({ attached: true })
  game.isCrashed.mockReturnValue(true)
  await expect(f.browser.request('b', 'lifecycle', args)).resolves.toEqual({ attached: false })
  f.add('one', 'https://example.com')
  await expect(f.browser.request('c', 'lifecycle', args)).resolves.toEqual({ attached: false })
  f.add('one', undefined, true)
  await expect(f.browser.request('d', 'lifecycle', args)).resolves.toEqual({ attached: false })
  expect(game.close).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})

it('refuses observation of a crashed game with a restart instruction', async () => {
  const f = fixture(); const game = f.add('one'); game.isCrashed.mockReturnValue(true)
  await expect(f.browser.request('observe', 'tree', { runId: 'one', sessionId: 'task' })).rejects.toThrow('Game page crashed; call game_start')
  expect(game.close).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})

it('restores rendering policy and removes listeners on navigation, stop and reset', async () => {
  const f = fixture()
  const policy = f.browser as unknown as { retainRendering(guest: unknown, url: string): void }
  const url = 'http://127.0.0.1/game/one'
  const page = f.add('one'); policy.retainRendering(page, url)
  expect(page.getBackgroundThrottling()).toBe(false)
  page.emit('did-start-navigation', { isMainFrame: false, url: 'https://example.com' })
  expect(page.getBackgroundThrottling()).toBe(false)
  page.emit('did-start-navigation', { isMainFrame: true, url: 'https://example.com' })
  expect(page.getBackgroundThrottling()).toBe(true)
  expect(page.listenerCount('did-start-navigation')).toBe(0)
  policy.retainRendering(page, url)
  await f.browser.request('stop', 'stop', { runId: 'one', sessionId: 'task' })
  expect(page.getBackgroundThrottling()).toBe(true)
  const other = f.add('two'); other.setBackgroundThrottling(false)
  policy.retainRendering(other, url); f.browser.reset()
  expect(other.getBackgroundThrottling()).toBe(false)
  expect(other.listenerCount('did-start-navigation')).toBe(0)
})

it.each(['failure', 'cancellation'])('restores rendering policy during open %s', async (mode) => {
  const f = fixture(); const guest = f.add('unused')
  const abort = new AbortController()
  const broken = Object.assign(guest, { executeJavaScript: async () => {
    if (mode === 'cancellation') { abort.abort(); return true }
    throw new Error('fixture failed readiness')
  } })
  const browser = new GameBrowser({ findGame: () => ({ guest: broken }) } as never, () => f.window as never)
  const internal = browser as unknown as {
    reveal(): Promise<void>
    openGuest(id: string, runId: string, sessionId: string, url: string, window: unknown, signal: AbortSignal): Promise<void>
  }
  const previous = f.add('previous', 'http://127.0.0.1/game/previous')
  const running = browser as unknown as { runs: Map<string, unknown> }
  running.runs.set('previous', { url: 'http://127.0.0.1/game/previous', sessionId: 'task', guest: previous })
  vi.spyOn(internal, 'reveal').mockResolvedValue(undefined)
  await expect(internal.openGuest('a', 'run', 'task', 'http://127.0.0.1/game/one', f.window, abort.signal)).rejects.toThrow()
  expect(guest.getBackgroundThrottling()).toBe(true)
  expect(guest.listenerCount('did-start-navigation')).toBe(0)
  expect(guest.close).toHaveBeenCalledOnce()
  expect(previous.close).not.toHaveBeenCalled()
  expect(running.runs.has('previous')).toBe(true)
  expect(f.send).toHaveBeenCalledWith(expect.any(String), { sessionId: 'task', url: 'http://127.0.0.1/game/one' })
  browser.dispose()
})


describe('physical game key validation', () => {
  it.each([['ArrowRight', 'Right'], ['ArrowLeft', 'Left'], ['w', 'w'], ['W', 'W'], [' ', 'Space'], ['Space', 'Space'], ['Enter', 'Return'], ['Return', 'Return'], ['F12', 'F12'], ['num0', 'num0'], ['Shift', 'Shift'], ['PageDown', 'PageDown']])('accepts %s as %s', (key, expected) => {
    expect(gamePhysicalKey(key)).toBe(expected)
  })
  it.each(['ui_right', 'move_left', 'ArrowRght', '', 'F25', 'Ctrl+W', '\n'])('rejects unsupported key %j with repair guidance', (key) => {
    expect(() => gamePhysicalKey(key)).toThrow(/physical key.*Use a browser keyboard key.*InputMap action names/)
  })
  it('rejects an action name before sending any Electron input', async () => {
    const f = fixture(); const game = Object.assign(f.add('one'), { sendInputEvent: vi.fn() })
    await expect(f.browser.request('invalid-key', 'key', { runId: 'one', sessionId: 'task', key: 'ui_right', duration_ms: 600 })).rejects.toThrow('not physical keys')
    expect(game.sendInputEvent).not.toHaveBeenCalled()
  })
})


describe('simultaneous physical game keys', () => {
  it('validates all keys and rejects normalized alias conflicts', () => {
    expect(gamePhysicalKeys(['ArrowRight', 'Space'])).toEqual(['Right', 'Space'])
    expect(gamePhysicalKeys(['A', 'Space'])).toEqual(['A', 'Space'])
    expect(() => gamePhysicalKeys(['a', 'A'])).toThrow('duplicate physical keys')
    expect(() => gamePhysicalKeys(['W', 'w'])).toThrow('duplicate physical keys')
    if (process.platform === 'darwin') {
      expect(() => gamePhysicalKeys(['Meta', 'Super'])).toThrow('duplicate physical keys')
      expect(() => gamePhysicalKeys(['Meta', 'Command'])).toThrow('duplicate physical keys')
    }
    expect(() => gamePhysicalKeys(['ArrowRight', 'Right'])).toThrow('duplicate physical keys')
    expect(() => gamePhysicalKeys(['Space', ' '])).toThrow('duplicate physical keys')
    for (const pair of [['Enter', 'Return'], ['Esc', 'Escape'], ['Ctrl', 'Control'], ['Cmd', 'Command'], ['Option', 'Alt'], ['CapsLock', 'Capslock'], ['NumLock', 'Numlock'], ['ScrollLock', 'Scrolllock']]) {
      expect(() => gamePhysicalKeys(pair)).toThrow('duplicate physical keys')
    }
    for (const keys of [[], Array(9).fill('w'), ['w', 'ui_jump'], 'w']) expect(() => gamePhysicalKeys(keys)).toThrow()
  })
  it('holds the chord together and releases in reverse order', async () => {
    const guest = { sendInputEvent: vi.fn((_event: Electron.KeyboardInputEvent) => {}), isDestroyed: () => false }
    await holdGameKeys(guest, ['Right', 'Space'], 0, new AbortController().signal)
    expect(guest.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'keyDown', keyCode: 'Right' }, { type: 'keyDown', keyCode: 'Space' },
      { type: 'keyUp', keyCode: 'Space' }, { type: 'keyUp', keyCode: 'Right' },
    ])
  })
  it('releases both keys when cancelled', async () => {
    const controller = new AbortController()
    const guest = { sendInputEvent: vi.fn((_event: Electron.KeyboardInputEvent) => {}), isDestroyed: () => false }
    const pending = holdGameKeys(guest, ['Right', 'Space'], 10000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(guest.sendInputEvent.mock.calls.slice(-2).map(([event]) => event)).toEqual([{ type: 'keyUp', keyCode: 'Space' }, { type: 'keyUp', keyCode: 'Right' }])
  })
  it('releases earlier keys despite a down and release failure', async () => {
    const guest = { sendInputEvent: vi.fn((event: Electron.KeyboardInputEvent) => { if (event.keyCode === 'Space') throw new Error('send failed') }), isDestroyed: () => false }
    await expect(holdGameKeys(guest, ['Right', 'Space'], 0, new AbortController().signal)).rejects.toThrow('send failed')
    expect(guest.sendInputEvent).toHaveBeenLastCalledWith({ type: 'keyUp', keyCode: 'Right' })
  })
  it.each([['w', 'ui_jump'], ['ArrowRight', 'Right'], ['Space', ' '], ['a', 'A']])('rejects invalid or duplicate chord %j before revealing or sending input', async (...keys) => {
    const f = fixture(); const guest = Object.assign(f.add('one'), { sendInputEvent: vi.fn() })
    await expect(f.browser.request('bad-chord', 'keys', { runId: 'one', sessionId: 'task', keys })).rejects.toThrow(keys.includes('ui_jump') ? 'not physical keys' : 'duplicate physical keys')
    expect(f.send).not.toHaveBeenCalled()
    expect(guest.sendInputEvent).not.toHaveBeenCalled()
  })
})


it('allows the reproduce bridge watchdog to report before the browser deadline', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  try {
    const f = fixture()
    for (const [operation, deadline] of [['reproduce', 90000], ['state', 60000], ['keys', 60000]] as const) {
      await expect(f.browser.request(operation, operation, { runId: 'missing', sessionId: 'task' })).rejects.toThrow()
      expect(timeout).toHaveBeenLastCalledWith(deadline)
    }
  } finally { timeout.mockRestore() }
})

it.each(['frame', 'capture'])('records screenshot %s failure without leaking page content', async (stage) => {
  const f = fixture()
  Object.assign(f.window, { isVisible: () => false, getContentBounds: () => ({ width: 1280, height: 820 }) })
  const pending = new Promise<never>(() => {})
  const game = Object.assign(f.add('one'), {
    executeJavaScript: vi.fn(() => stage === 'frame' ? pending : Promise.resolve({ frame: 12 })),
    capturePage: vi.fn(() => pending),
  })
  vi.spyOn(f.browser as unknown as { reveal(): Promise<void> }, 'reveal').mockResolvedValue(undefined)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const operation = f.browser.request('capture-request', 'screenshot', { runId: 'one', sessionId: 'task' })
    const rejected = expect(operation).rejects.toThrow(`Game screenshot ${stage} failed (cancelled or timed out)`)
    await vi.waitFor(() => { expect(stage === 'frame' ? game.executeJavaScript : game.capturePage).toHaveBeenCalledOnce() })
    await f.browser.request('cancel-request', 'cancel', { requestId: 'capture-request' })
    await rejected
    expect(warning).toHaveBeenCalledWith('Game screenshot failed', {
      stage, aborted: true, host_destroyed: false, host_visible: false, host_background_throttling: true,
      host_content_size: { width: 1280, height: 820 }, guest_destroyed: false,
      guest_crashed: false, guest_background_throttling: true,
    })
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/https?:|game\/one/)
    expect(f.state.active.has('capture-request')).toBe(false)
  } finally { warning.mockRestore(); f.browser.dispose() }
})

it('keeps the current rendering lease when an older run stops after guest navigation', async () => {
  const f = fixture()
  const oldUrl = 'http://127.0.0.1/game/one'
  const newUrl = 'http://127.0.0.1/game/two'
  const guest = f.add('old')
  const current = { url: oldUrl }
  guest.getURL = () => current.url
  const policy = f.browser as unknown as { retainRendering(guest: unknown, url: string): void }
  policy.retainRendering(guest, oldUrl)
  guest.emit('did-start-navigation', { isMainFrame: true, url: newUrl })
  current.url = newUrl
  policy.retainRendering(guest, newUrl)
  f.state.runs.set('new', { url: newUrl, sessionId: 'task', guest })
  await expect(f.browser.request('stop-old', 'stop', { runId: 'old', sessionId: 'task' })).resolves.toEqual({ stopped: true })
  expect(guest.getBackgroundThrottling()).toBe(false)
  expect(f.window.webContents.getBackgroundThrottling()).toBe(false)
  expect(guest.close).not.toHaveBeenCalled()
  expect(guest.listenerCount('did-start-navigation')).toBe(1)
  await f.browser.request('stop-new', 'stop', { runId: 'new', sessionId: 'task' })
  expect(guest.getBackgroundThrottling()).toBe(true)
  expect(guest.close).toHaveBeenCalledOnce()
  expect(guest.listenerCount('did-start-navigation')).toBe(0)
})

it.each([true, false])('holds the host compositor across two games and restores its original %s policy', async (original) => {
  const f = fixture(); const host = f.window.webContents
  host.setBackgroundThrottling(original)
  const policy = f.browser as unknown as { retainRendering(guest: unknown, url: string): void }
  const one = f.add('one'); const two = f.add('two')
  policy.retainRendering(one, one.getURL()); policy.retainRendering(two, two.getURL())
  expect(host.getBackgroundThrottling()).toBe(false)
  await f.browser.request('stop-one', 'stop', { runId: 'one', sessionId: 'task' })
  expect(host.getBackgroundThrottling()).toBe(false)
  expect(two.getBackgroundThrottling()).toBe(false)
  await f.browser.request('stop-two', 'stop', { runId: 'two', sessionId: 'task' })
  expect(host.getBackgroundThrottling()).toBe(original)
})

it('releases host rendering on navigation and reset while leaving ordinary pages untouched', () => {
  const f = fixture(); const host = f.window.webContents
  const policy = f.browser as unknown as { retainRendering(guest: unknown, url: string): void }
  const one = f.add('one'); const two = f.add('two')
  policy.retainRendering(one, one.getURL()); policy.retainRendering(two, two.getURL())
  one.emit('did-start-navigation', { isMainFrame: true, url: 'https://example.com' })
  expect(host.getBackgroundThrottling()).toBe(false)
  f.browser.reset()
  expect(host.getBackgroundThrottling()).toBe(true)
  expect(one.getBackgroundThrottling()).toBe(true)
  expect(two.getBackgroundThrottling()).toBe(true)
})

it('does not retain a second lease when a game contents is its own host', async () => {
  const f = fixture(); const guest = f.add('one')
  Object.assign(guest, { hostWebContents: guest })
  const policy = f.browser as unknown as { retainRendering(guest: unknown, url: string): void }
  policy.retainRendering(guest, guest.getURL())
  expect(f.window.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
  await f.browser.request('stop', 'stop', { runId: 'one', sessionId: 'task' })
  expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
})

it('rolls back failed host acquisition before registration and permits retry', async () => {
  const f = fixture(); const host = f.window.webContents; const guest = f.add('one')
  const policy = f.browser as unknown as {
    retainRendering(guest: unknown, url: string): void
    hostRendering: Map<unknown, unknown>
    rendering: Map<unknown, unknown>
  }
  host.setBackgroundThrottling.mockImplementationOnce(() => { throw new Error('native setter failed') })
  expect(() => { policy.retainRendering(guest, guest.getURL()) }).toThrow('native setter failed')
  expect(host.getBackgroundThrottling()).toBe(true)
  expect(policy.hostRendering.size).toBe(0); expect(policy.rendering.size).toBe(0)
  policy.retainRendering(guest, guest.getURL())
  expect(host.getBackgroundThrottling()).toBe(false)
  await f.browser.request('stop', 'stop', { runId: 'one', sessionId: 'task' })
  expect(host.getBackgroundThrottling()).toBe(true)
  expect(policy.hostRendering.size).toBe(0)
})

it('continues reset after a rendering restore throws and releases other guests', () => {
  const f = fixture(); const one = f.add('one'); const two = f.add('two')
  const policy = f.browser as unknown as { retainRendering(guest: unknown, url: string): void; hostRendering: Map<unknown, unknown> }
  policy.retainRendering(one, one.getURL()); policy.retainRendering(two, two.getURL())
  one.setBackgroundThrottling.mockImplementation(() => { throw new Error('do not log https://secret.invalid/token') })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(() => { f.browser.reset() }).not.toThrow()
    expect(warning).toHaveBeenCalledWith('Game rendering cleanup failed', { stage: 'reset-rendering', error_type: 'Error' })
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret')
    expect(two.getBackgroundThrottling()).toBe(true)
    expect(f.window.webContents.getBackgroundThrottling()).toBe(true)
    expect(policy.hostRendering.size).toBe(0)
    expect(one.close).toHaveBeenCalledOnce(); expect(two.close).toHaveBeenCalledOnce()
    expect(f.state.runs.size).toBe(0)
  } finally { warning.mockRestore() }
})

it('rolls back host retention if the guest setter fails during acquisition', () => {
  const f = fixture(); const guest = f.add('one')
  const policy = f.browser as unknown as {
    retainRendering(guest: unknown, url: string): void
    hostRendering: Map<unknown, unknown>
    rendering: Map<unknown, unknown>
  }
  guest.setBackgroundThrottling.mockImplementationOnce(() => { throw new Error('guest setter failed') })
  expect(() => { policy.retainRendering(guest, guest.getURL()) }).toThrow('guest setter failed')
  expect(f.window.webContents.getBackgroundThrottling()).toBe(true)
  expect(policy.hostRendering.size).toBe(0); expect(policy.rendering.size).toBe(0)
  expect(guest.listenerCount('did-start-navigation')).toBe(0)
})
