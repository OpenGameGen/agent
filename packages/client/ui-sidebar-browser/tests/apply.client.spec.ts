// @vitest-environment jsdom
/** Browser type, Slot, locale, and HMR disposal through the real registries. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShortcutRegistry } from '@deepseek-ai/dsh-client-shortcuts/src/client/registry.ts'
import type { ShortcutCommand, ShortcutPlatform } from '@deepseek-ai/dsh-client-shortcuts/client'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { BrowserBody } from '../src/client/view/BrowserBody.tsx'
import { BrowserTitle } from '../src/client/view/BrowserTitle.tsx'
import type { BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { BROWSER_ID, BROWSER_KIND } from '../src/client/definition.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

interface Recorded {
  name: string
  key: string
  locale?: string
  store?: unknown
  inject?: unknown
  component: unknown
}

async function boot(platform: ShortcutPlatform = 'macos', runtime: 'desktop' | 'web' = 'desktop') {
  const ctx = new Context()
  contexts.push(ctx)
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((namespace: string, value: unknown) => {
      dictionaries.set(namespace, value)
      return () => { dictionaries.delete(namespace) }
    }),
  }
  const openTabs = createSnapshotStore<readonly { sessionId: string; tabId: TabId }[]>([])
  const target = { sessionId: 'session', paneId: 'pane' }
  const sidebar = { openTabs, commandTarget: vi.fn<() => typeof target | undefined>(() => target),
    openTabFromTarget: vi.fn(), mounted: createSnapshotStore<string | undefined>('session'),
    openTab: vi.fn(), active: vi.fn(() => ({ id: 'game-tab' as TabId, kind: 'browser', contentId: 'browser', title: 'Browser' })),
    close: vi.fn(), focus: vi.fn(), isExpanded: vi.fn(() => false), toggleExpanded: vi.fn() }
  const registry = new ShortcutRegistry(runtime, platform)
  ctx.provide('sidebarRight', sidebar as never)
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => registry.register(command) } as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ phase: 'ready', items: [] }) } as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber, openTabs, registry, sidebar, target }
}

describe('ui-sidebar-browser apply', () => {
  it('opens the game once, reveals that tab on reuse, and refuses a different visible task', async () => {
    let receive!: (request: { sessionId: string; url: string; reuse?: boolean }) => void
    const dispose = vi.fn()
    const bridge: DesktopBrowserBridge = {
      acquire: vi.fn(), release: vi.fn(), onOpenRequested: vi.fn(),
      onGameOpen: (listener) => { receive = listener; return dispose },
    }
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, browser: bridge })
    const h = await boot()
    const request = { sessionId: 'session', url: 'http://127.0.0.1:9999/game/run/index.html' }
    receive(request)
    expect(h.sidebar.openTab).toHaveBeenCalledWith('browser', { params: { url: request.url } })
    h.openTabs.set([{ sessionId: 'session', tabId: 'game-tab' as TabId }])
    receive({ ...request, reuse: true })
    expect(h.sidebar.focus).toHaveBeenCalledWith('game-tab')
    expect(h.sidebar.toggleExpanded).toHaveBeenCalled()
    expect(h.sidebar.openTab).toHaveBeenCalledTimes(1)
    h.sidebar.mounted.set('other')
    expect(() => { receive({ ...request, reuse: true }) }).toThrow('Select the game task')
    h.sidebar.mounted.set('session'); h.openTabs.set([])
    expect(() => { receive({ ...request, reuse: true }) }).toThrow('Game tab closed')
    await h.fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('closes only the retired game tab after replacement and defers background session cleanup', async () => {
    let opened!: Parameters<NonNullable<DesktopBrowserBridge['onGameOpen']>>[0]
    let closed!: Parameters<NonNullable<DesktopBrowserBridge['onGameClosed']>>[0]
    const disposeClosed = vi.fn()
    const bridge: DesktopBrowserBridge = {
      acquire: vi.fn(), release: vi.fn(), onOpenRequested: vi.fn(),
      onGameOpen: (listener) => { opened = listener; return () => {} },
      onGameClosed: (listener) => { closed = listener; return disposeClosed },
    }
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, browser: bridge })
    const h = await boot()
    const first = { sessionId: 'session', url: 'http://127.0.0.1:9999/game/old/index.html' }
    const next = { sessionId: 'session', url: 'http://127.0.0.1:9999/game/new/index.html' }
    opened(first)
    h.sidebar.active.mockReturnValue({ id: 'new-game' as TabId, kind: 'browser', contentId: 'browser', title: 'Browser' })
    opened(next)
    h.openTabs.set([
      { sessionId: 'session', tabId: 'game-tab' as TabId },
      { sessionId: 'session', tabId: 'new-game' as TabId },
      { sessionId: 'session', tabId: 'ordinary-browser' as TabId },
    ])
    expect(h.sidebar.close).not.toHaveBeenCalled()
    closed({ ...first, sessionId: 'other' })
    closed({ ...first, url: 'https://example.com/' })
    expect(h.sidebar.close).not.toHaveBeenCalled()
    closed(first)
    expect(h.sidebar.close).toHaveBeenCalledExactlyOnceWith('game-tab')
    opened({ ...next, reuse: true })
    expect(h.sidebar.focus).toHaveBeenLastCalledWith('new-game')
    closed(first)
    expect(h.sidebar.close).toHaveBeenCalledTimes(1)
    h.sidebar.mounted.set('other')
    closed(next)
    expect(h.sidebar.close).toHaveBeenCalledTimes(1)
    h.sidebar.mounted.set('session')
    await Promise.resolve()
    expect(h.sidebar.close).toHaveBeenNthCalledWith(2, 'new-game')
    expect(h.sidebar.close).not.toHaveBeenCalledWith('ordinary-browser')
    await h.fiber.dispose()
    expect(disposeClosed).toHaveBeenCalledOnce()
    closed(next)
    expect(h.sidebar.close).toHaveBeenCalledTimes(2)
  })

  it.each([0, 1])('binds and rebinds session controllers under desktop protocol %s', async (protocolVersion) => {
    const acquire = vi.fn(async () => ({ lease: 'test-lease' as DesktopBrowserLeaseId, partition: 'test-partition' }))
    const bridge: DesktopBrowserBridge = {
      acquire,
      release: vi.fn(async () => {}),
      onOpenRequested: vi.fn(() => () => {}),
    }
    vi.stubGlobal('dshDesktop', { protocolVersion, browser: bridge })
    const h = await boot()
    expect(h.tabs.get(BROWSER_KIND)?.keepMounted).toBe(protocolVersion === 1)
    const injectFace = h.registered.find(entry => entry.name === 'sidebar.right.pane.tab')!.inject as
      (sessionId: string, actions: Parameters<BrowserInjected['rebind']>[0]) => BrowserInjected
    const firstStore = createBrowserStore().create(`apply-first-${protocolVersion}`)
    const replacementStore = createBrowserStore().create(`apply-replacement-${protocolVersion}`)
    const controller = injectFace('session', firstStore.actions)
    expect(injectFace('session', replacementStore.actions)).toBe(controller)
    const host = document.createElement('div')
    host.id = `browser-apply-${protocolVersion}`
    document.body.append(host)
    const signal = new AbortController()
    const tabId = 'apply-tab' as TabId
    try {
      controller.mount({ tabId, signal: signal.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: 'https://example.test/', openTab: vi.fn() })
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeDefined()
      expect(firstStore.getSnapshot().byTab[tabId]).toBeUndefined()
      if (protocolVersion === 1) await vi.waitFor(() => { expect(acquire).toHaveBeenCalledWith('session:session', 'https://example.test/') })
      else expect(host.querySelector('iframe')).not.toBeNull()
      h.openTabs.set([{ sessionId: 'other', tabId }, { sessionId: 'session', tabId: 'other-tab' as TabId }])
      signal.abort()
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeUndefined()
      const reopened = new AbortController()
      controller.mount({ tabId, signal: reopened.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: 'https://retained.example/', openTab: vi.fn() })
      h.openTabs.set([{ sessionId: 'session', tabId }])
      reopened.abort()
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeDefined()
      const active = new AbortController()
      controller.mount({ tabId, signal: active.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: undefined, openTab: vi.fn() })
      await h.fiber.dispose()
      expect(controller.keyedHooks.browserState(tabId)).toBeUndefined()
    } finally {
      await h.fiber.dispose()
      host.remove()
    }
  })

  it('registers a multi-instance builtin and its body and title', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(BROWSER_KIND)
    expect(definition).toMatchObject({ id: BROWSER_ID, kind: BROWSER_KIND, multiple: true, priority: 'builtin' })
    expect(definition?.title('sidebar://browser')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[30, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarBrowser')).toEqual({ zh, en })
    expect(dictionaries.get('sidebarBrowser')).toMatchObject({
      zh: { 'guide.description': '浏览网页' },
      en: { 'guide.description': 'Browse web pages' },
    })
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', BROWSER_ID, 'sidebarBrowser', BrowserBody],
      ['sidebar.right.pane.tab.title', BROWSER_ID, undefined, BrowserTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(registered[0]?.inject).toBeTypeOf('function')
    const injectFace = registered[0]?.inject as ((sessionId: string, actions: unknown) => unknown)
    const browser = injectFace('session', { replace: vi.fn(), forget: vi.fn() }) as BrowserInjected
    expect(browser.keyedHooks.browserState('missing')).toBeUndefined()
    expect(typeof browser.mount).toBe('function')
  })

  it.each(['macos', 'windows'] as const)('opens the resolved Browser target with the %s default and releases the shortcut', async (platform) => {
    const h = await boot(platform)
    try {
      expect(h.registry.catalog.getSnapshot()[0]?.keys).toEqual(platform === 'macos' ? ['⌘', 'T'] : ['Ctrl', '+', 'T'])
      expect(h.tabs.get(BROWSER_KIND)?.guide?.[0]?.commandId).toBe('browser.new')
      const gesture = { code: 'KeyT', control: platform === 'windows', meta: platform === 'macos',
        alt: false, shift: false, repeat: false, composing: false, defaultPrevented: false }
      const context = { region: 'page' as const, modal: null, target: null }
      const consume = vi.fn()
      expect(h.registry.dispatch(gesture, context, consume).status).toBe('handled')
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledExactlyOnceWith('browser', h.target)
      h.registry.dispatch({ ...gesture, repeat: true }, context, consume)
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledOnce()
      h.sidebar.commandTarget.mockReturnValue(undefined)
      expect(h.registry.dispatch(gesture, context, consume).status).toBe('blocked')
    } finally { await h.fiber.dispose() }
    expect(h.registry.catalog.getSnapshot()).toEqual([])
  })

  it('publishes the macOS Web Browser default', async () => {
    const h = await boot('macos', 'web')
    try { expect(h.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyT', modifiers: ['alt', 'meta'] }) }
    finally { await h.fiber.dispose() }
  })

  it('removes every registration when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(BROWSER_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})

it('opens and reveals a dedicated ordinary tool tab independently from game tabs and scopes retirement to its task', async () => {
  let open: Parameters<NonNullable<DesktopBrowserBridge['onToolTabOpen']>>[0] | undefined
  let closed: Parameters<NonNullable<DesktopBrowserBridge['onToolTabClosed']>>[0] | undefined
  const disposeOpen = vi.fn(), disposeClosed = vi.fn()
  const bridge: DesktopBrowserBridge = {
    acquire: vi.fn(), release: vi.fn(), onOpenRequested: vi.fn(),
    onToolTabOpen(listener) { open = listener; return disposeOpen },
    onToolTabClosed(listener) { closed = listener; return disposeClosed },
  }
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, browser: bridge })
  const h = await boot()
  const request = { id: 'main-tool-id', sessionId: 'session', url: 'https://perchance.org/img-generator', title: 'Perchance 生图' }
  open?.(request)
  expect(h.sidebar.openTab).toHaveBeenCalledWith('browser', {
    params: { url: request.url, toolTabId: request.id, toolTitle: request.title },
  })
  h.openTabs.set([{ sessionId: 'session', tabId: 'game-tab' as TabId }])
  open?.({ ...request, reuse: true })
  expect(h.sidebar.focus).toHaveBeenCalledWith('game-tab')
  expect(h.sidebar.openTab).toHaveBeenCalledTimes(1)
  h.sidebar.mounted.set('other')
  expect(() => open?.({ ...request, reuse: true })).toThrow('Select the image-generation task')
  closed?.({ id: request.id, sessionId: 'session' })
  expect(h.sidebar.close).not.toHaveBeenCalled()
  h.sidebar.mounted.set('session')
  expect(h.sidebar.close).toHaveBeenCalledWith('game-tab')
  await h.fiber.dispose()
  expect(disposeOpen).toHaveBeenCalledOnce(); expect(disposeClosed).toHaveBeenCalledOnce()
})
