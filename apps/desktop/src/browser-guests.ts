/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  toolTabId?: string
  isolationId?: string
  cleanup?: Promise<void>
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly toolTabs = new Map<string, { owner: WebContents; url: string; consumed: boolean }>()
  private readonly partitions = new Map<string, string>()
  private readonly isolation = new Map<string, { owner: WebContents; url: string; consumed: boolean }>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined) {}

  /** Bind one main-owned tool tab to an ordinary workspace guest, without game isolation. */
  authorizeToolTab(owner: WebContents, id: string, url: string): (preserveGuest?: boolean) => Promise<void> {
    if (!id || this.toolTabs.has(id) || !this.allowedNavigation(url)) throw new Error('Invalid tool browser authorization')
    this.toolTabs.set(id, { owner, url, consumed: false })
    return async (preserveGuest = false) => {
      this.toolTabs.delete(id)
      for (const [leaseId, lease] of this.leases) if (lease.owner === owner && lease.toolTabId === id) {
        if (preserveGuest) delete lease.toolTabId
        else await this.release(owner, leaseId)
      }
    }
  }

  /** Resolve only the guest carrying this main-issued identity and owner. */
  findToolTab(owner: WebContents, id: string): WebContents | undefined {
    for (const lease of this.leases.values()) {
      if (lease.owner === owner && lease.toolTabId === id && lease.guest && !lease.guest.isDestroyed()) return lease.guest
    }
    return undefined
  }

  /** Approve exactly one fresh game partition; never accepts a renderer-selected partition. */
  isolateNextGame(owner: WebContents, url: string): { id: string; finish(): void; cancel(): Promise<void> } {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.pathname.startsWith('/game/')) throw new Error('Invalid isolated game URL')
    const id = randomUUID()
    this.isolation.set(id, { owner, url, consumed: false })
    return { id, finish: () => { this.isolation.delete(id) }, cancel: async () => {
      this.isolation.delete(id)
      for (const [leaseId, lease] of this.leases) {
        if (lease.isolationId !== id) continue
        if (lease.guest !== undefined && !lease.guest.isDestroyed() && lease.guest.getURL() !== url
          && lease.guest.getURL() !== `about:blank#${leaseId}`) continue
        await this.release(owner, leaseId)
      }
    } }
  }

  /** Close and await cleanup for a game-only partition; ordinary workspace pages are untouched. */
  async releaseIsolatedGame(guest: WebContents): Promise<boolean> {
    for (const [id, lease] of this.leases) if (lease.guest === guest && lease.isolationId !== undefined) {
      await this.release(lease.owner, id)
      return true
    }
    return false
  }

  private cleanupPartition(lease: GuestLease): Promise<void> {
    if (lease.isolationId === undefined) return Promise.resolve()
    lease.cleanup ??= (async () => {
      const isolated = session.fromPartition(lease.partition)
      await isolated.closeAllConnections()
      await isolated.clearStorageData()
      await isolated.clearCache()
    })()
    return lease.cleanup
  }

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @param initialUrl - optional pending URL, used only to match a main-process one-time game approval.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown, initialUrl?: unknown, toolTabId?: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    const tool = typeof toolTabId === 'string' ? this.toolTabs.get(toolTabId) : undefined
    if (toolTabId !== undefined && (tool === undefined || tool.owner !== owner || tool.consumed || tool.url !== initialUrl)) {
      throw new Error('desktop browser: invalid or already consumed tool tab authorization')
    }
    const approval = tool === undefined
      ? [...this.isolation].find(([, value]) => value.owner === owner && !value.consumed && value.url === initialUrl)
      : undefined
    if (approval !== undefined) {
      const [isolationId, value] = approval
      value.consumed = true
      const partition = `dsh-game-isolated-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      const lease = randomUUID() as DesktopBrowserLeaseId
      this.leases.set(lease, { owner, partition, isolationId, attached: false })
      return { lease, partition, approvedInitialUrl: value.url }
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    if (tool) tool.consumed = true
    this.leases.set(lease, { owner, partition, attached: false, ...(typeof toolTabId === 'string' ? { toolTabId } : {}) })
    return { lease, partition, ...(tool ? { approvedInitialUrl: tool.url } : {}) }
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
    await this.cleanupPartition(lease)
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => {
          lease.releaseInput?.(); this.leases.delete(id)
          void this.cleanupPartition(lease).catch((error: unknown) => { console.error('Isolated game storage cleanup failed', error) })
        })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [id, tab] of this.toolTabs) if (tab.owner === owner) this.toolTabs.delete(id)
      for (const [id, approval] of this.isolation) if (approval.owner === owner) this.isolation.delete(id)
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  /** Find a live approved guest at an exact product-owned URL. @param url - Full run URL. @returns Its guest and owner. */
  findGame(url: string, isolationId?: string): { guest: WebContents; owner: WebContents; isolationId?: string } | undefined {
    for (const lease of this.leases.values()) {
      if (lease.guest !== undefined && !lease.guest.isDestroyed() && lease.guest.getURL() === url
        && (isolationId === undefined || lease.isolationId === isolationId)) {
        return { guest: lease.guest, owner: lease.owner, ...(lease.isolationId === undefined ? {} : { isolationId: lease.isolationId }) }
      }
    }
    return undefined
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
