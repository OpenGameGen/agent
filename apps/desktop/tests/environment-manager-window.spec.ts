import { afterEach, expect, it, vi } from 'vitest'
import { showEnvironmentManager } from '../src/product/environment-manager-window.ts'
import { runCreationSetup } from '../src/product/creation-setup-process.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const windows: Window[] = []
  class Window extends EventEmitter {
    destroyed = false
    html = ''
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async (source: string) => { void source }),
    })
    constructor(readonly options: unknown) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    async loadURL(url: string) { this.html = decodeURIComponent(url.slice(url.indexOf(',') + 1)) }
  }
  return { windows, Window }
})
vi.mock('electron', () => ({ BrowserWindow: native.Window }))
vi.mock('../src/product/creation-setup-process.ts', () => ({ runCreationSetup: vi.fn() }))
const options = { primaryRuntime: '/bundled/primary', environment: { AGENT_ENV_CONFIG: '/private/launcher.json', AGENT_ENV_RESOURCES: '/bundled/environments' }, chinese: true }
afterEach(() => { for (const window of native.windows.splice(0)) window.destroy(); vi.mocked(runCreationSetup).mockReset() })

it('opens only on demand, blocks arbitrary commands and executes a fixed component install', async () => {
  vi.mocked(runCreationSetup).mockImplementation(async (config) => { config.onReport?.(JSON.stringify({ godot: { version: '4.6.stable', executable: '/Applications/Godot.app', installed: true, source: 'system' } })) })
  expect(native.windows).toHaveLength(0)
  await showEnvironmentManager(options)
  const window = native.windows[0]!
  expect(window.options).toMatchObject({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  expect(runCreationSetup).toHaveBeenCalledOnce()
  expect(vi.mocked(runCreationSetup).mock.calls[0]![0].action).toBe('status')
  expect(window.webContents.executeJavaScript.mock.calls.some(call => call[0].includes('复用本机安装'))).toBe(true)
  const event = { preventDefault: vi.fn() }
  window.webContents.emit('will-navigate', event, 'https://untrusted.invalid/install')
  window.webContents.emit('will-navigate', event, 'opengamegen-environment://ensure/arbitrary')
  expect(runCreationSetup).toHaveBeenCalledOnce()
  window.webContents.emit('will-navigate', event, 'opengamegen-environment://ensure/blender')
  await vi.waitFor(() => { expect(runCreationSetup).toHaveBeenCalledTimes(2) })
  expect(vi.mocked(runCreationSetup).mock.calls[1]![0]).toMatchObject({ action: 'ensure', target: 'blender' })
  await showEnvironmentManager(options)
  expect(native.windows).toHaveLength(1)
})

it('closing a busy manager cancels preparation without quitting the workspace', async () => {
  vi.mocked(runCreationSetup).mockImplementation(config => new Promise<void>((resolve) => { config.signal.addEventListener('abort', () => { resolve() }, { once: true }) }))
  const work = showEnvironmentManager(options)
  await vi.waitFor(() => { expect(runCreationSetup).toHaveBeenCalledOnce() })
  native.windows[0]!.destroy()
  expect(vi.mocked(runCreationSetup).mock.calls[0]![0].signal.aborted).toBe(true)
  await work
})
