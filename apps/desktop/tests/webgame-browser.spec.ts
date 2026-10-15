import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter(), BrowserWindow: { fromWebContents: vi.fn() } }
})
import { ipcMain } from 'electron'
import { GameBrowser } from '../src/product/game-browser.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

it('opens a web preview without Godot readiness and reads only fixed state/error scripts', async () => {
  const events = new EventEmitter()
  const url = 'http://127.0.0.1:12345/game/test/index.html'
  let destroyed = false
  const execute = vi.fn(async (source: string) => {
    if (source === "document.readyState === 'complete'") return true
    if (source.includes('const state = globalThis.__game')) return { state: { score: 3, status: 'won' }, title: 'Test' }
    return true
  })
  const owner = { isDestroyed: () => false, getBackgroundThrottling: () => true, setBackgroundThrottling: vi.fn(),
    send: (_channel: string, payload: { id: string }) => {
      ipcMain.emit(DESKTOP_IPC.browserGameOpened, { sender: owner }, { id: payload.id })
    } }
  const window = { webContents: owner, isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
  const guest = { hostWebContents: owner, executeJavaScript: execute, isDestroyed: () => destroyed, isCrashed: () => false,
    getURL: () => url, getBackgroundThrottling: () => true, setBackgroundThrottling: vi.fn(),
    on: events.on.bind(events), off: events.off.bind(events), once: events.once.bind(events),
    close: () => { destroyed = true; events.emit('destroyed') } }
  const browser = new GameBrowser({ findGame: () => ({ guest, owner }), releaseIsolatedGame: async () => false } as never,
    () => window as never)
  try {
    await browser.request('open', 'webgame:open', { runId: 'run', sessionId: 'task', url })
    const state = await browser.request('state', 'webgame:state', { runId: 'run', sessionId: 'task' })
    expect(state).toEqual({ state: { score: 3, status: 'won' }, title: 'Test' })
    await browser.request('freeze', 'webgame:freeze', { runId: 'run', sessionId: 'task' })
    await browser.request('thaw', 'webgame:thaw', { runId: 'run', sessionId: 'task' })
    expect(execute).toHaveBeenCalledWith('globalThis.__webGamePreviewClock.freeze()')
    expect(execute).toHaveBeenCalledWith('globalThis.__webGamePreviewClock.thaw()')
    expect(execute.mock.calls.every(([source]) => !source.includes('openGame'))).toBe(true)
    await expect(browser.request('wrong', 'state', { runId: 'run', sessionId: 'task' })).rejects.toThrow('protocol')
    await browser.request('stop', 'webgame:stop', { runId: 'run', sessionId: 'task' })
    expect(destroyed).toBe(true)
  } finally { browser.dispose() }
})
