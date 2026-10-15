/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { createIframePage } from './pages.ts'
import { createElectronPage } from './electron/pages.ts'
import type { DesktopBrowserBridge } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Optional initial Browser URL. */
    browser: { readonly url?: string; readonly toolTabId?: string; readonly toolTitle?: string }
  }
}

/** Required Browser services. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Register the Browser type, localized guide entry, body, and title. */
export function apply(ctx: Context): void {
  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.new' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('browser', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-browser: shortcut')
  })
  const store = createBrowserStore()
  const openTabs = ctx.sidebarRight.openTabs
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly browser?: DesktopBrowserBridge }
  }).dshDesktop
  const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined
  const toolTabs = new Map<string, { sessionId: string; tabId: Parameters<typeof ctx.sidebarRight.focus>[0]; closed: boolean }>()
  const retireToolTabs = (): void => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    for (const [id, tab] of toolTabs) {
      if (!tab.closed || tab.sessionId !== sessionId) continue
      toolTabs.delete(id)
      if (openTabs.getSnapshot().some(item => item.sessionId === sessionId && item.tabId === tab.tabId)) ctx.sidebarRight.close(tab.tabId)
    }
  }
  const onToolTabOpen = desktop?.onToolTabOpen?.bind(desktop)
  const onToolTabClosed = desktop?.onToolTabClosed?.bind(desktop)
  if (onToolTabOpen) ctx.effect(() => onToolTabOpen((request) => {
    if (ctx.sidebarRight.mounted.getSnapshot() !== request.sessionId) throw new Error('Select the image-generation task before opening its browser tab')
    const existing = toolTabs.get(request.id)
    if (request.reuse) {
      if (!existing || existing.sessionId !== request.sessionId
        || !openTabs.getSnapshot().some(tab => tab.sessionId === request.sessionId && tab.tabId === existing.tabId)) {
        throw new Error('Dedicated image-generation tab closed; retry the tool to open a new tab')
      }
      ctx.sidebarRight.focus(existing.tabId)
    } else {
      if (existing) throw new Error('Dedicated tool browser identity already exists')
      ctx.sidebarRight.openTab('browser', { params: { url: request.url, toolTabId: request.id, toolTitle: request.title } })
      const tab = ctx.sidebarRight.active()
      if (tab) toolTabs.set(request.id, { sessionId: request.sessionId, tabId: tab.id, closed: false })
    }
    if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
  }), 'ui-sidebar-browser.tool-open')
  if (onToolTabClosed) ctx.effect(() => onToolTabClosed((request) => {
    const tab = toolTabs.get(request.id)
    if (!tab || tab.sessionId !== request.sessionId) return
    if (request.preserve) { toolTabs.delete(request.id); return }
    tab.closed = true
    retireToolTabs()
  }), 'ui-sidebar-browser.tool-closed')
  ctx.effect(() => ctx.sidebarRight.mounted.subscribe(retireToolTabs), 'ui-sidebar-browser.tool-mounted')
  ctx.effect(() => () => { toolTabs.clear() }, 'ui-sidebar-browser.tool-disposal')
  const gameTabs = new Map<string, {
    sessionId: string
    tab: NonNullable<ReturnType<typeof ctx.sidebarRight.active>>
    closed: boolean
  }>()
  const closeRetiredGames = (): void => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    for (const [url, game] of gameTabs) {
      if (!game.closed || game.sessionId !== sessionId) continue
      gameTabs.delete(url)
      if (openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === game.tab.id)) ctx.sidebarRight.close(game.tab.id)
    }
  }
  ctx.effect(() => () => { gameTabs.clear() }, 'ui-sidebar-browser.game-disposal')
  const onGameClosed = desktop?.onGameClosed?.bind(desktop)
  if (onGameClosed !== undefined) {
    ctx.effect(() => onGameClosed((request) => {
      const game = gameTabs.get(request.url)
      if (game === undefined || game.sessionId !== request.sessionId) return
      game.closed = true
      closeRetiredGames()
    }), 'ui-sidebar-browser.game-closed')
    // close() targets the mounted session; defer background cleanup until that
    // session is visible, never close an identically positioned unrelated tab.
    ctx.effect(() => ctx.sidebarRight.mounted.subscribe(() => { queueMicrotask(closeRetiredGames) }), 'ui-sidebar-browser.game-mounted')
    ctx.effect(() => openTabs.subscribe(() => { queueMicrotask(closeRetiredGames) }), 'ui-sidebar-browser.game-tabs')
  }
  const onGameOpen = desktop?.onGameOpen?.bind(desktop)
  if (onGameOpen !== undefined) ctx.effect(() => onGameOpen((request) => {
    if (ctx.sidebarRight.mounted.getSnapshot() !== request.sessionId) throw new Error('Select the game task before starting its browser test')
    const existing = gameTabs.get(request.url)
    if (request.reuse) {
      if (existing === undefined || !ctx.sidebarRight.openTabs.getSnapshot().some(tab => tab.tabId === existing.tab.id)) throw new Error('Game tab closed; start the game again')
      ctx.sidebarRight.focus(existing.tab.id)
      if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
      return
    }
    ctx.sidebarRight.openTab('browser', { params: { url: request.url } })
    const opened = ctx.sidebarRight.active()
    if (opened !== undefined) gameTabs.set(request.url, { sessionId: request.sessionId, tab: opened, closed: false })
  }), 'ui-sidebar-browser.game-open')
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: desktop !== undefined }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context, factory: (sessionId: BrowserBodyProps['sessionId']) => BrowserPageFactory): void => {
    const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
    scope.effect(() => async () => {
      const pending = [...controllers.values()].map(controller => controller.dispose())
      controllers.clear()
      await Promise.all(pending)
    }, 'ui-sidebar-browser.frames')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
      inject: (sessionId, actions) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions)
          return existing
        }
        const controller = createBrowserControllers(actions, factory(sessionId), tabId =>
          openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId))
        controllers.set(sessionId, controller)
        return controller
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
  }
  if (desktop === undefined) installFrames(ctx, () => createIframePage)
  else ctx.inject(['workspaces'], (scope) => {
    installFrames(scope, sessionId => options => createElectronPage(options, desktop,
      signal => browserWorkspace(scope.workspaces.list, sessionId, signal)))
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
