/** Product game control of the existing right-Sidebar webview, scoped to a run URL. */
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopBrowserGuests } from '../browser-guests.ts'
import { DESKTOP_IPC } from '../ipc.ts'

/** @param value - IPC value. @returns Valid object payload. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid game payload')
  return value as Record<string, unknown>
}
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () =>{  reject(new Error('Browser operation timed out or was cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { if (abort !== undefined) signal.removeEventListener('abort', abort) }
}
/** Cleanup diagnostics deliberately omit exception text, URLs and page contents. */
function renderingCleanupWarning(stage: string, error: unknown): void {
  const known = error instanceof Error && ['Error', 'TypeError', 'RangeError'].includes(error.name) ? error.name : 'unknown'
  console.warn('Game rendering cleanup failed', { stage, error_type: known })
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid game string')
  return value
}
function number(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error('Invalid game number')
  return value
}

/** Validate physical keyboard keys before Electron can silently ignore an unknown name. */
export function gamePhysicalKey(value: unknown): string {
  const key = text(value)
  const aliases: Record<string, string> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space', Enter: 'Return', Esc: 'Escape', Ctrl: 'Control', Cmd: 'Command', Option: 'Alt', CapsLock: 'Capslock', NumLock: 'Numlock', ScrollLock: 'Scrolllock' }
  const named = new Set(['Space', 'Tab', 'Capslock', 'CapsLock', 'Numlock', 'NumLock', 'Scrolllock', 'ScrollLock', 'Backspace', 'Delete', 'Insert', 'Return', 'Escape', 'Esc', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'PrintScreen', 'Shift', 'Control', 'Ctrl', 'Alt', 'Option', 'AltGr', 'Super', 'Meta', 'Command', 'Cmd', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv'])
  if (Object.hasOwn(aliases, key)) return aliases[key] ?? key
  if (/^[\x21-\x7e]$/.test(key) || /^(?:F(?:[1-9]|1[0-9]|2[0-4])|num[0-9])$/.test(key) || named.has(key)) return key
  throw new Error(`Unsupported physical key ${JSON.stringify(key)}. Use a browser keyboard key such as ArrowRight, w, Space, or Enter. Godot InputMap action names (for example ui_right) are not physical keys; inspect the project's action bindings and pass the bound key.`)
}

/** Normalize an entire chord before any input is sent. */
export function gamePhysicalKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error('keys must be an array of 1 to 8 physical keyboard keys')
  const normalized = value.map(gamePhysicalKey)
  const identities = normalized.map(key => /^[A-Za-z]$/.test(key) ? key.toLowerCase() : process.platform === 'darwin' && ['Meta', 'Super', 'Command'].includes(key) ? 'Command' : key)
  if (new Set(identities).size !== normalized.length) throw new Error('keys contains duplicate physical keys after normalization; aliases such as ArrowRight and Right refer to the same key. Pass each physical key only once.')
  return normalized
}

/** Hold a validated chord, releasing every attempted key even if another release fails. */
export async function holdGameKeys(guest: Pick<WebContents, 'sendInputEvent' | 'isDestroyed'>, keys: string[], duration: number, signal: AbortSignal): Promise<void> {
  const pressed: string[] = []
  let failed = false
  try {
    signal.throwIfAborted()
    for (const keyCode of keys) {
      pressed.push(keyCode)
      guest.sendInputEvent({ type: 'keyDown', keyCode })
    }
    await delay(duration, undefined, { signal })
  } catch (error) { failed = true; throw error }
  finally {
    let releaseError: unknown
    for (const keyCode of pressed.reverse()) {
      if (guest.isDestroyed()) break
      try { guest.sendInputEvent({ type: 'keyUp', keyCode }) }
      catch (error) { releaseError ??= error }
    }
    if (!failed && releaseError !== undefined) throw releaseError instanceof Error ? releaseError : new Error('Failed to release a game keyboard key')
  }
}

/** Controls only the guest created for an authenticated Host request. */
export class GameBrowser {
  private readonly runs = new Map<string, { url: string; sessionId: string; guest: WebContents; isolated?: boolean; web?: boolean }>()
  private readonly rendering = new Map<WebContents, { url: string; restore: () => void }>()
  private readonly hostRendering = new Map<WebContents, { original: boolean; guests: Set<WebContents> }>()
  private readonly active = new Map<string, AbortController>()
  private readonly opens = new Map<string, { owner: WebContents; resolve: () => void; reject: (error: Error) => void }>()
  private readonly opened = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') return
    const message = value as Record<string, unknown>
    const pending = this.opens.get(value.id)
    if (pending?.owner !== event.sender) return
    if (message.error !== undefined) pending.reject(new Error(typeof message.error === 'string' ? message.error.slice(0, 4096) : 'Invalid browser reply'))
    else pending.resolve()
  }
  constructor(private readonly guests: DesktopBrowserGuests, private readonly window: () => BrowserWindow | undefined) {
    ipcMain.on(DESKTOP_IPC.browserGameOpened, this.opened)
  }

  /** Release active inputs and destroy product test guests on application shutdown. */
  dispose(): void {
    ipcMain.off(DESKTOP_IPC.browserGameOpened, this.opened)
    this.reset()
  }

  /** Stop guest activity after the owning Host exits or restarts. */
  reset(): void {
    for (const controller of this.active.values()) controller.abort()
    for (const lease of [...this.rendering.values()]) {
      try { lease.restore() } catch (error) { renderingCleanupWarning('reset-rendering', error) }
    }
    for (const run of this.runs.values()) {
      try {
        const navigated = !run.guest.isDestroyed() && run.guest.getURL() !== run.url
        if (!run.guest.isDestroyed() && !navigated) run.guest.close({ waitForBeforeUnload: false })
        if (!navigated) this.notifyClosed(run)
      } catch (error) { renderingCleanupWarning('reset-guest', error) }
    }
    this.runs.clear()
  }

  /** Host teardown can outlive the renderer IPC context. */
  private notifyClosed(run: { sessionId: string; url: string }): void {
    const window = this.window()
    if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) return
    try {
      window.webContents.send(DESKTOP_IPC.browserGameClosed, { sessionId: run.sessionId, url: run.url })
    } catch (error) {
      // A closing renderer must not prevent cleanup of the remaining game runs.
      console.warn('Game sidebar cleanup notification failed', error)
    }
  }

  private async reveal(
    id: string, window: BrowserWindow, sessionId: string, url: string, reuse: boolean, signal: AbortSignal,
  ): Promise<void> {
    try {
      await bounded(new Promise<void>((resolve, reject) => {
        this.opens.set(id, { owner: window.webContents, resolve, reject })
        window.webContents.send(DESKTOP_IPC.browserGameOpen, { id, sessionId, url, reuse })
      }), signal)
    } finally { this.opens.delete(id) }
  }

  /** Keep the embedding compositor rendering while any owned game guest needs it. */
  private retainHostRendering(guest: WebContents): () => void {
    const host = guest.hostWebContents ?? this.window()?.webContents
    if (host === undefined || host === guest || host.isDestroyed()) return () => {}
    let lease = this.hostRendering.get(host)
    if (lease === undefined) {
      lease = { original: host.getBackgroundThrottling(), guests: new Set() }
      try { host.setBackgroundThrottling(false) }
      catch (error) {
        try { if (!host.isDestroyed()) host.setBackgroundThrottling(lease.original) }
        catch (restoreError) { renderingCleanupWarning('acquire-host-rollback', restoreError) }
        throw error
      }
      this.hostRendering.set(host, lease)
    }
    lease.guests.add(guest)
    let released = false
    return () => {
      if (released) return
      released = true
      lease.guests.delete(guest)
      if (lease.guests.size !== 0 || this.hostRendering.get(host) !== lease) return
      this.hostRendering.delete(host)
      if (!host.isDestroyed()) host.setBackgroundThrottling(lease.original)
    }
  }

  private retainRendering(guest: WebContents, url: string): void {
    const previous = this.rendering.get(guest)
    if (previous?.url === url) return
    previous?.restore()
    const original = guest.getBackgroundThrottling()
    const releaseHost = this.retainHostRendering(guest)
    let restored = false
    const restore = (): void => {
      if (restored) return
      restored = true
      guest.off('did-start-navigation', navigate)
      guest.off('destroyed', restore)
      this.rendering.delete(guest)
      try { if (!guest.isDestroyed()) guest.setBackgroundThrottling(original) }
      finally { releaseHost() }
    }
    const navigate = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (event.isMainFrame && event.url !== url) restore()
    }
    this.rendering.set(guest, { url, restore })
    guest.on('did-start-navigation', navigate)
    guest.once('destroyed', restore)
    try { guest.setBackgroundThrottling(false) }
    catch (error) {
      try { restore() } catch (restoreError) { renderingCleanupWarning('acquire-guest-rollback', restoreError) }
      throw error
    }
  }

  /** A retired run must not release a newer run's lease on a navigated guest. */
  private releaseRendering(guest: WebContents, url: string): void {
    const lease = this.rendering.get(guest)
    if (lease?.url === url) lease.restore()
  }

  private async openGuest(
    id: string, runId: string, sessionId: string, url: string, window: BrowserWindow, signal: AbortSignal, isolation = false, web = false,
  ): Promise<boolean> {
    let preparing: WebContents | undefined
    const approval = isolation ? this.guests.isolateNextGame(window.webContents, url) : undefined
    try {
      await this.reveal(id, window, sessionId, url, false, signal)
      while (!signal.aborted) {
        const found = this.guests.findGame(url, approval?.id)
        if (found !== undefined) {
          if (approval !== undefined && (found.owner !== window.webContents || found.isolationId !== approval.id)) throw new Error('Game isolation receipt mismatch')
          preparing = found.guest
          this.retainRendering(found.guest, url)
          const ready: unknown = await bounded(found.guest.executeJavaScript(web
            ? 'document.readyState === \'complete\''
            : 'Boolean(globalThis.openGame && globalThis.openGame.ready)'), signal)
          signal.throwIfAborted()
          if (ready === true) { if (web) await bounded(found.guest.executeJavaScript(`(() => {
              if (!globalThis.__webGameErrors) {
                globalThis.__webGameErrors = [];
                const record = error => { if (globalThis.__webGameErrors.length < 30) globalThis.__webGameErrors.push(String(error).slice(0, 2000)); };
                addEventListener('error', event => record(event.message));
                addEventListener('unhandledrejection', event => record(event.reason));
              }
              return true;
            })()`), signal)
          this.runs.set(runId, { url, sessionId, guest: found.guest, isolated: isolation, web }); return isolation }
        }
        await delay(50, undefined, { signal })
      }
      signal.throwIfAborted()
    } catch (error) {
      if (preparing !== undefined) this.releaseRendering(preparing, url)
      const found = this.guests.findGame(url, approval?.id)
      if (approval !== undefined) await approval.cancel()
      else if (found !== undefined) found.guest.close({ waitForBeforeUnload: false })
      // The failed run was never registered, so stop(runId) cannot remove this new tab.
      // Match only its exact URL; a previous successful run has a different URL.
      if (found !== undefined || preparing === undefined || preparing.isDestroyed() || preparing.getURL() === url) {
        this.notifyClosed({ sessionId, url })
      }
      throw error
    } finally { approval?.finish() }
    return false
  }

  /** @param id - Correlation id. @param operation - Fixed operation name.
   * @param args - Validated inside this owner. @returns Browser evidence. */
  async request(id: string, operation: string, args: Record<string, unknown>): Promise<unknown> {
    const webOperation = operation.startsWith('webgame:')
    if (webOperation) operation = operation.slice('webgame:'.length)
    if (operation === 'cancel') { this.active.get(text(args.requestId))?.abort(); return { cancelled: true } }
    const controller = new AbortController()
    let screenshotStage = 'validate'
    let screenshotGuest: WebContents | undefined
    this.active.set(id, controller)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(operation === 'reproduce' ? 90_000 : 60_000)])
    try {
      const runId = text(args.runId)
      const sessionId = text(args.sessionId)
      if (operation === 'open') {
        const url = text(args.url)
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.pathname.startsWith('/game/')) throw new Error('Invalid local game URL')
        const window = this.window()
        if (window === undefined || window.isDestroyed()) throw new Error('Open the desktop workspace first')
        window.show(); window.focus()
        const isolated = await this.openGuest(id, runId, sessionId, url, window, signal, args.isolation === true, webOperation)
        return { runId, ready: true, isolated }
      }
      let run = this.runs.get(runId)
      if (run === undefined || run.sessionId !== sessionId) throw new Error('Game run missing or belongs to another task; call game_start')
      if ((run.web === true) !== webOperation) throw new Error('Game protocol does not match this run')
      if (operation === 'lifecycle') {
        const attached = !run.guest.isDestroyed() && !run.guest.isCrashed() && run.guest.getURL() === run.url
        return { attached }
      }
      // An explicit game_start reuses the exported files even when the user closed its tab.
      // Observation/input still refuses stale guests; only scene restart may reopen them.
      if (operation === 'scene' && (run.guest.isDestroyed() || run.guest.isCrashed() || run.guest.getURL() !== run.url)) {
        const window = this.window()
        if (window === undefined || window.isDestroyed()) throw new Error('Open the desktop workspace first')
        if (!run.guest.isDestroyed() && run.guest.isCrashed() && run.guest.getURL() === run.url) {
          this.releaseRendering(run.guest, run.url)
          const crashedGuest = run.guest
          const destroyed = new Promise<void>((resolve) => { crashedGuest.once('destroyed', resolve) })
          crashedGuest.close({ waitForBeforeUnload: false })
          await bounded(destroyed, signal)
          this.notifyClosed(run)
        }
        await this.openGuest(id, runId, sessionId, run.url, window, signal, run.isolated === true)
        run = this.runs.get(runId)
        if (run === undefined) throw new Error('Game reopen did not establish a run')
      }
      const guest = run.guest
      if (operation === 'screenshot') screenshotGuest = guest
      if (operation === 'stop') {
        this.releaseRendering(guest, run.url)
        const navigated = !guest.isDestroyed() && guest.getURL() !== run.url
        if (!guest.isDestroyed() && !navigated && !(await this.guests.releaseIsolatedGame(guest))) {
          const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
          guest.close({ waitForBeforeUnload: false })
          await bounded(destroyed, signal)
        }
        this.runs.delete(runId)
        if (!navigated) this.notifyClosed(run)
        return { stopped: true }
      }
      if (!guest.isDestroyed() && guest.isCrashed() && guest.getURL() === run.url) throw new Error('Game page crashed; call game_start to reopen the cached preview')
      if (guest.isDestroyed() || guest.getURL() !== run.url) throw new Error('Game page closed or navigated; call game_start')
      const physicalKeys = operation === 'keys' ? gamePhysicalKeys(args.keys) : operation === 'key' ? [gamePhysicalKey(args.key)] : []
      const keyDuration = physicalKeys.length > 0 ? number(args.duration_ms ?? 80, 10_000) : 0
      const visibleWindow = this.window()
      if (visibleWindow === undefined) throw new Error('Game window unavailable')
      if (operation === 'screenshot') screenshotStage = 'reveal'
      await this.reveal(id, visibleWindow, sessionId, run.url, true, signal)
      const bridge = async (command: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
        signal.throwIfAborted()
        const result: unknown = await bounded(guest.executeJavaScript(`globalThis.openGame.request(${JSON.stringify({ ...payload, command })})`), signal)
        signal.throwIfAborted()
        const response = record(result)
        if (response.error !== undefined) throw new Error(text(response.error))
        return response
      }
      if (operation === 'screenshot') {
        screenshotStage = 'frame'
        if (run.web) await bounded(guest.executeJavaScript('new Promise(resolve => globalThis.__webGamePreviewClock.nextFrame(() => resolve(true)))'), signal)
        else await bridge('frame')
        screenshotStage = 'capture'
        const image = await bounded(guest.capturePage(), signal)
        screenshotStage = 'encode'
        if (image.isEmpty()) throw new Error('Game screenshot is empty')
        const size = image.getSize()
        if (size.width * size.height > 16_777_216) throw new Error('Game viewport exceeds screenshot limit')
        const png = image.toPNG()
        if (png.length > 16 * 1024 * 1024) throw new Error('Game screenshot exceeds byte limit')
        return { png: png.toString('base64'), ...size }
      }
      if (operation === 'key' || operation === 'keys' || operation === 'click' || operation === 'click_ui') {
        const window = BrowserWindow.fromWebContents(guest.hostWebContents ?? guest)
        if (window === null) throw new Error('Game window unavailable')
        window.show(); window.focus(); guest.focus()
        if (operation === 'key' || operation === 'keys') {
          await holdGameKeys(guest, physicalKeys, keyDuration, signal)
        } else {
          let x = number(args.x ?? 0, 32768), y = number(args.y ?? 0, 32768)
          if (operation === 'click_ui') {
            const target = record(await bridge('ui_target', { node_path: text(args.node_path) }))
            x = number(target.x, 32768); y = number(target.y, 32768)
          }
          const bounds: unknown = await bounded(guest.executeJavaScript('({width:innerWidth,height:innerHeight})'), signal)
          const viewport = record(bounds)
          if (x >= Number(viewport.width) || y >= Number(viewport.height)) throw new Error('Click is outside game viewport CSS pixels')
          try { guest.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }) }
          finally { if (!guest.isDestroyed()) guest.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }) }
        }
        if (run.web) await bounded(guest.executeJavaScript('new Promise(resolve => globalThis.__webGamePreviewClock.nextFrame(() => resolve(true)))'), signal)
        else await bridge('frame')
        return { delivered: true, effect: 'Inspect state or assert an outcome; delivery is not test success' }
      }
      if (run.web) {
        if (!webOperation) throw new Error('Wrong game protocol for this run')
        if (operation === 'freeze' || operation === 'thaw') {
          return await bounded(guest.executeJavaScript(operation === 'freeze' ? 'globalThis.__webGamePreviewClock.freeze()' : 'globalThis.__webGamePreviewClock.thaw()'), signal)
        }
        if (operation === 'state') {
          return await bounded(guest.executeJavaScript(`(() => {
            const state = globalThis.__game;
            if (state === undefined) return { state: null, title: document.title, text: document.body.innerText.slice(0, 4000) };
            const json = JSON.stringify(state);
            if (json.length > 65536) throw new Error('Game state exceeds limit');
            return { state: JSON.parse(json), title: document.title };
          })()`), signal)
        }
        if (operation === 'errors') return await bounded(guest.executeJavaScript('({errors: globalThis.__webGameErrors ?? [], observerInstalled: Array.isArray(globalThis.__webGameErrors)})'), signal)
        throw new Error('Unsupported web game operation')
      }
      const allowed = ['scene', 'tree', 'logs', 'ui', 'state', 'exists', 'errors', 'watch', 'events', 'freeze', 'thaw', 'step', 'metrics', 'reproduce']
      if (!allowed.includes(operation)) throw new Error('Unsupported game operation')
      const { runId: _runId, sessionId: _session, ...payload } = args
      return await bridge(operation, payload)
    } catch (error) {
      if (operation === 'screenshot') {
        // Host cancellation can win the IPC response race. Preserve the failing
        // stage locally without logging URLs, project paths or page content.
        const diagnostics: Record<string, unknown> = { stage: screenshotStage, aborted: signal.aborted }
        try {
          const window = this.window()
          diagnostics.host_destroyed = window === undefined || window.isDestroyed()
          if (window !== undefined && !window.isDestroyed()) {
            diagnostics.host_visible = window.isVisible()
            diagnostics.host_background_throttling = window.webContents.getBackgroundThrottling()
            const { width, height } = window.getContentBounds()
            diagnostics.host_content_size = { width, height }
          }
          diagnostics.guest_destroyed = screenshotGuest === undefined || screenshotGuest.isDestroyed()
          if (screenshotGuest !== undefined && !screenshotGuest.isDestroyed()) {
            diagnostics.guest_crashed = screenshotGuest.isCrashed()
            diagnostics.guest_background_throttling = screenshotGuest.getBackgroundThrottling()
          }
        } catch { diagnostics.state_unavailable = true }
        console.warn('Game screenshot failed', diagnostics)
        throw new Error(`Game screenshot ${screenshotStage} failed (${signal.aborted ? 'cancelled or timed out' : 'browser error'}). See desktop diagnostics for stage and rendering state.`, { cause: error })
      }
      throw error
    } finally { this.active.delete(id) }
  }
}
