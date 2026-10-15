import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareCreationSetup } from '../src/product/creation-setup-window.ts'
import { runCreationSetup } from '../src/product/creation-setup-process.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const windows: Window[] = []
  class Window extends EventEmitter {
    destroyed = false
    readonly html: string[] = []
    readonly changes: string[] = []
    readonly show = vi.fn()
    readonly webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async (source: string) => { this.changes.push(source) }),
    })
    constructor(readonly options: unknown) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    async loadURL(url: string) { this.html.push(decodeURIComponent(url.slice(url.indexOf(',') + 1))) }
  }
  return { app, windows, Window }
})
vi.mock('electron', () => ({ app: native.app, BrowserWindow: native.Window }))
vi.mock('../src/product/creation-setup-process.ts', () => ({ runCreationSetup: vi.fn() }))
const options = { primaryRuntime: '/bundled/primary', environment: { AGENT_ENV_CONFIG: '/private/launcher.json', AGENT_ENV_RESOURCES: '/bundled/environments' }, chinese: true }
beforeEach(() => { vi.useFakeTimers(); vi.mocked(runCreationSetup).mockReset().mockRejectedValueOnce(new Error('missing component')); native.app.quit.mockClear() })
afterEach(() => { for (const window of native.windows.splice(0)) window.destroy(); native.app.removeAllListeners(); vi.useRealTimers() })

it.each([true, false])('renders a localized isolated setup document (Chinese=%s)', async (chinese) => {
  vi.mocked(runCreationSetup).mockImplementation(async (config) => { config.onProgress('Setup-stage: {"target":"godot","phase":"ready","reused":true}') })
  await prepareCreationSetup({ ...options, chinese })
  const window = native.windows[0]!
  expect(window.options).toMatchObject({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  expect(window.destroyed).toBe(true)
  expect(native.app.quit).not.toHaveBeenCalled()
  await expect(window.html[0]).toMatchFileSnapshot(`expected/creation-setup-${chinese ? 'zh' : 'en'}.html`)
  expect(window.changes.some(source => source.includes(chinese ? '复用已有安装' : 'existing installation'))).toBe(true)
})

it('keeps failed setup open, blocks remote navigation, and resumes only on the owned retry action', async () => {
  vi.mocked(runCreationSetup).mockRejectedValueOnce(new Error('download failed')).mockResolvedValueOnce(undefined)
  const work = prepareCreationSetup(options)
  await vi.advanceTimersByTimeAsync(0)
  const window = native.windows[0]!
  expect(window.destroyed).toBe(false)
  expect(window.changes.some(source => source.includes('download failed') && source.includes('"failed":true'))).toBe(true)
  const event = { preventDefault: vi.fn() }
  window.webContents.emit('will-navigate', event, 'https://other.invalid/')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(runCreationSetup).toHaveBeenCalledTimes(2)
  window.webContents.emit('will-navigate', event, 'https://setup.invalid/retry')
  await work
  expect(runCreationSetup).toHaveBeenCalledTimes(3)
  expect(window.destroyed).toBe(true)
  expect(native.app.quit).not.toHaveBeenCalled()
})

it('closing setup cancels the child and waits for cleanup before rejecting', async () => {
  let childFinished!: () => void
  vi.mocked(runCreationSetup).mockImplementation(config => new Promise<void>((_resolve, reject) => {
    config.signal.addEventListener('abort', () => { childFinished = () =>{  reject(config.signal.reason instanceof Error ? config.signal.reason : new Error('cancelled')) } }, { once: true })
  }))
  const work = prepareCreationSetup(options)
  const rejected = expect(work).rejects.toThrow('cancelled')
  await vi.advanceTimersByTimeAsync(0)
  native.windows[0]!.destroy()
  expect(native.app.quit).toHaveBeenCalledOnce()
  expect(childFinished).toBeDefined()
  childFinished()
  await rejected
  expect(native.app.listenerCount('before-quit')).toBe(0)
})

it('healthy startup creates no setup window and only runs read-only checks', async () => {
  vi.mocked(runCreationSetup).mockReset().mockResolvedValue(undefined)
  await prepareCreationSetup(options)
  expect(native.windows).toHaveLength(0)
  expect(runCreationSetup).toHaveBeenCalledOnce()
  expect(vi.mocked(runCreationSetup).mock.calls[0]![0].checkOnly).toBe(true)
  expect(native.app.listenerCount('before-quit')).toBe(0)
})
