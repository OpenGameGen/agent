/** Per-task, main-owned Perchance tabs in the ordinary Sidebar browser. */
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopBrowserGuests } from '../browser-guests.ts'
import { DESKTOP_IPC } from '../ipc.ts'

export const PERCHANCE_URL = 'https://perchance.org/img-generator'
interface Tab {
  id: string
  sessionId: string
  owner: WebContents
  backgroundThrottling?: boolean
  guest?: WebContents
  revoke: (preserveGuest?: boolean) => Promise<void>
}

/** Sidebar tab identity is independent of its URL and of every game run. */
export class PerchanceTabs {
  private readonly tabs = new Map<string, Tab>()
  private readonly pending = new Map<string, { owner: WebContents; resolve: () => void; reject: (error: Error) => void }>()
  private readonly opened = (event: Electron.IpcMainEvent, message: unknown): void => {
    if (typeof message !== 'object' || message === null || !('requestId' in message) || typeof message.requestId !== 'string') return
    const pending = this.pending.get(message.requestId)
    if (!pending || pending.owner !== event.sender) return
    if ('error' in message) pending.reject(new Error(String(message.error).slice(0, 4096)))
    else pending.resolve()
  }

  constructor(private readonly guests: DesktopBrowserGuests, private readonly window: () => BrowserWindow | undefined) {
    ipcMain.on(DESKTOP_IPC.browserToolTabOpened, this.opened)
  }

  /** Keep verification in the same task's dedicated tab; never select a URL-matching ordinary tab. */
  async open(sessionId: string, refresh: boolean, signal: AbortSignal): Promise<WebContents> {
    signal.throwIfAborted()
    signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const window = this.window()
    if (!window || window.isDestroyed()) throw new Error('Open the Desktop workspace before generating images')
    let tab = this.tabs.get(sessionId)
    if (tab && (tab.owner !== window.webContents || !tab.guest || tab.guest.isDestroyed() || tab.guest.isCrashed())) {
      await this.clear(sessionId)
      tab = undefined
    }
    if (tab?.guest && tab.guest.getURL() !== PERCHANCE_URL) {
      await this.clear(sessionId, true)
      throw new Error('Perchance tab navigated away; control was revoked. Retry to open a new dedicated image-generation tab')
    }
    const existing = tab !== undefined
    if (!tab) {
      const id = randomUUID()
      tab = { id, sessionId, owner: window.webContents, revoke: this.guests.authorizeToolTab(window.webContents, id, PERCHANCE_URL) }
      this.tabs.set(sessionId, tab)
    }
    try {
      await this.reveal(tab, existing, signal)
      while (!tab.guest) {
        signal.throwIfAborted()
        if (tab.owner.isDestroyed()) throw new Error('Desktop workspace closed')
        const found = this.guests.findToolTab(tab.owner, tab.id)
        if (found) tab.guest = found
        if (!tab.guest) await delay(100, undefined, { signal })
      }
      const guest = tab.guest
      if (existing && refresh) {
        // A new document discards late outputs while ordinary workspace cookies
        // retain user-completed verification. The Sidebar observes load events.
        await this.bound(guest.loadURL(PERCHANCE_URL), signal)
      }
      tab.backgroundThrottling ??= guest.getBackgroundThrottling()
      guest.setBackgroundThrottling(false)
      return guest
    } catch (error) { await this.clear(sessionId); throw error }
  }

  private async reveal(tab: Tab, reuse: boolean, signal: AbortSignal): Promise<void> {
    const requestId = randomUUID()
    try {
      await this.bound(new Promise<void>((resolve, reject) => {
        this.pending.set(requestId, { owner: tab.owner, resolve, reject })
        tab.owner.send(DESKTOP_IPC.browserToolTabOpen, {
          requestId, id: tab.id, sessionId: tab.sessionId, url: PERCHANCE_URL, title: 'Perchance 生图', reuse,
        })
      }), signal)
    } finally { this.pending.delete(requestId) }
  }

  private async bound<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    try {
      return await Promise.race([value, new Promise<never>((_resolve, reject) => {
        abort = () => { reject(new Error('Perchance Sidebar operation cancelled or timed out')) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
    } finally { if (abort) signal.removeEventListener('abort', abort) }
  }

  /** Retire only this task's owned tag; user-navigated content can remain ordinary. */
  async clear(sessionId: string, preserveGuest = false): Promise<void> {
    const tab = this.tabs.get(sessionId)
    if (!tab) return
    this.tabs.delete(sessionId)
    if (tab.guest && !tab.guest.isDestroyed() && tab.backgroundThrottling !== undefined) {
      tab.guest.setBackgroundThrottling(tab.backgroundThrottling)
    }
    await tab.revoke(preserveGuest)
    if (!tab.owner.isDestroyed()) tab.owner.send(DESKTOP_IPC.browserToolTabClosed, { id: tab.id, sessionId, preserve: preserveGuest })
  }

  /** Release only product-owned tabs on Host shutdown; shared workspace cookies survive. */
  reset(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('Perchance Host stopped'))
    for (const sessionId of [...this.tabs.keys()]) void this.clear(sessionId).catch((error: unknown) => { console.error('Perchance tab cleanup failed', error) })
  }

  dispose(): void { this.reset(); ipcMain.off(DESKTOP_IPC.browserToolTabOpened, this.opened) }
}
