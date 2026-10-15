/** Official Perchance webpage operations scoped to one dedicated ordinary Sidebar tab. */
import { session, type BrowserWindow, type WebContents, type WebFrameMain } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import { perchanceOutput } from './perchance-output.ts'
import { perchancePage } from './perchance-page.ts'
import { checkPerchanceNetwork } from './perchance-network.ts'

import type { DesktopBrowserGuests } from '../browser-guests.ts'
import { PerchanceTabs, PERCHANCE_URL } from './perchance-tab.ts'
export { PERCHANCE_URL } from './perchance-tab.ts'
export function perchanceOrigin(url: string): boolean {
  try { const value = new URL(url); return value.protocol === 'https:' && (value.hostname === 'perchance.org' || value.hostname.endsWith('.perchance.org')) }
  catch { return false }
}

export class PerchanceBrowser {
  private readonly tabs: PerchanceTabs
  private readonly refresh = new Set<string>()
  private active: { id: string; sessionId: string; controller: AbortController } | undefined
  private readonly network = new Map<string, { controller: AbortController; done: Promise<unknown> }>()

  constructor(guests: DesktopBrowserGuests, window: () => BrowserWindow | undefined) { this.tabs = new PerchanceTabs(guests, window) }

  /** Stop product-owned tags without clearing ordinary or game browser sessions. */
  reset(): void {
    for (const check of this.network.values()) check.controller.abort()
    this.active?.controller.abort()
    this.active = undefined
    this.refresh.clear()
    this.tabs.reset()
  }

  dispose(): void { this.reset(); this.tabs.dispose() }

  private finish(id: string): void {
    if (this.active?.id === id) this.active = undefined
  }

  private async evaluate(frame: WebFrameMain, script: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    if (!perchanceOrigin(frame.url) || frame.top?.url !== PERCHANCE_URL) throw new Error('Perchance frame left its dedicated tab')
    let abort: (() => void) | undefined
    try {
      const value: unknown = await Promise.race([frame.executeJavaScript(script), new Promise<never>((_resolve, reject) => {
        abort = () => { reject(new Error('Perchance operation cancelled or timed out; generation outcome unknown')) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
      signal.throwIfAborted()
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Perchance page result')
      return value as Record<string, unknown>
    } finally { if (abort) signal.removeEventListener('abort', abort) }
  }

  /** Fixed operations only; caller never supplies URL or JavaScript. */
  async request(id: string, operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (operation === 'network') {
      if (this.network.size > 0) throw new Error('Perchance network check already running')
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
      const done = checkPerchanceNetwork((url, init) => session.defaultSession.fetch(url, init), signal)
        .finally(() => { this.network.delete(id) })
      this.network.set(id, { controller, done })
      return done
    }
    if (operation === 'cancel') {
      const check = typeof args.requestId === 'string' ? this.network.get(args.requestId) : undefined
      if (check) { check.controller.abort(); await check.done }
      if (this.active && args.requestId === this.active.id) {
        this.active.controller.abort()
        await this.tabs.clear(this.active.sessionId)
      }
      return { cancelled: true }
    }
    if (operation !== 'generate' && operation !== 'probe') throw new Error('Unsupported Perchance operation')
    if (this.active) throw new Error('Perchance is generating another image; wait before retrying')
    if (operation === 'generate' && (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000)) throw new Error('Prompt must contain 1–4000 characters')
    if (typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 1024) throw new Error('Image generation requires an active task')
    const style = typeof args.style === 'string' && args.style.length <= 200 ? args.style : ''
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    const sessionId = args.sessionId
    const controller = new AbortController()
    this.active = { id, sessionId, controller }
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(operation === 'probe' ? 30_000 : 240_000)])
    let verificationAttempted = false
    const verify = async (frame: WebFrameMain): Promise<boolean> => {
      if (verificationAttempted) return false
      verificationAttempted = true
      const result = await this.evaluate(frame, perchancePage('verify'), signal)
      if (result.clicked !== true) return false
      await delay(3000, undefined, { signal })
      return (await this.evaluate(frame, perchancePage('inspect'), signal)).challenge !== true
    }
    let submitted = false
    let navigated = false
    let guest: WebContents | undefined
    const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (event.isMainFrame && event.url !== PERCHANCE_URL) {
        navigated = true
        controller.abort(new Error('Perchance tab navigated away; control revoked'))
      }
    }
    try {
      guest = await this.tabs.open(sessionId, this.refresh.has(sessionId), signal)
      this.refresh.delete(sessionId)
      guest.on('did-start-navigation', navigation)
      if (operation === 'probe') {
        const response = await guest.session.fetch('https://image-generation.perchance.org/embed', { signal, redirect: 'error' })
        await response.body?.cancel()
        if (!response.ok) throw new Error(`Perchance image-generation endpoint unavailable: HTTP ${response.status}`)
      }
      let frame: WebFrameMain | undefined
      let baseline: string[] = []
      let dimensions: number[] = []
      const readyUntil = Date.now() + 45_000
      while (Date.now() < readyUntil) {
        signal.throwIfAborted()
        if (guest.isDestroyed()) throw new Error('Perchance image-generation tab closed')
        const frames = guest.mainFrame.framesInSubtree.filter(item => perchanceOrigin(item.url))
        const priorImages: string[] = []
        const candidates: WebFrameMain[] = []
        for (const candidate of frames) {
          const state = await this.evaluate(candidate, perchancePage('inspect'), signal)
          if (operation === 'probe' && state.challenge === true) return { reachable: true, ready: false, reason: 'verification_required' }
          if (state.challenge === true && !await verify(candidate)) throw new Error('Perchance requires website verification. Complete it in the Perchance Sidebar image-generation tab, then retry; no image was generated by this call')
          if (Array.isArray(state.sources)) priorImages.push(...state.sources.filter((source): source is string => typeof source === 'string'))
          if (state.ready === true) { candidates.push(candidate); dimensions = state.dimensions as number[] }
        }
        if (candidates.length > 1) throw new Error('Multiple Perchance generators detected; page layout is ambiguous')
        if (candidates.length === 1) {
          // The page can display controls before its generator imports settle.
          // Wait for a complete, stable document before submitting a prompt.
          const candidate = candidates[0]
          if (candidate) {
            await delay(3000, undefined, { signal })
            const state = await this.evaluate(candidate, perchancePage('inspect'), signal)
            if (state.ready === true && state.complete === true && state.pageError !== true) {
              frame = candidate; baseline = priorImages; dimensions = state.dimensions as number[]; break
            }
          }
        }
        await delay(500, undefined, { signal })
      }
      if (!frame) throw new Error('Perchance prompt/Generate controls unavailable. Check the dedicated Sidebar tab for loading, verification or layout changes, then retry')
      if (operation === 'probe') {
        const state = await this.evaluate(frame, perchancePage('inspect'), signal)
        return { reachable: true, ready: true, styles: state.styles,
          targets: ['https://perchance.org/img-generator', 'https://image-generation.perchance.org/embed'] }
      }
      if (style) {
        await this.evaluate(frame, perchancePage('style', '', [], [], style), signal)
        await delay(1500, undefined, { signal })
      }
      await this.evaluate(frame, perchancePage('prepare', prompt), signal)
      // Input/change handlers can rebuild Perchance's generator asynchronously.
      // Submit on a later settled document, not in the same event tick.
      await delay(1500, undefined, { signal })
      const prepared = await this.evaluate(frame, perchancePage('inspect'), signal)
      if (prepared.ready !== true || prepared.pageError === true) throw new Error('Perchance page failed to initialize after updating the prompt; retry')
      dimensions = prepared.dimensions as number[]
      await this.evaluate(frame, perchancePage('submit', prompt), signal)
      submitted = true
      while (!signal.aborted) {
        if (guest.isDestroyed()) throw new Error('Perchance image-generation tab closed during generation')
        if (guest.getURL() !== PERCHANCE_URL) {
          await this.tabs.clear(sessionId, true)
          throw new Error('Perchance tab navigated away; control was revoked')
        }
        if (!perchanceOrigin(frame.url)) throw new Error('Generator frame navigated away')
        for (const candidate of guest.mainFrame.framesInSubtree.filter(item => perchanceOrigin(item.url))) {
          const state = await this.evaluate(candidate, perchancePage('inspect'), signal)
          if (state.challenge === true && !await verify(candidate)) throw new Error('Perchance requested verification during generation; complete it in the dedicated Sidebar tab then retry')
        }
        for (const candidate of frame.framesInSubtree.filter(item => perchanceOrigin(item.url))) {
          const classification = perchanceOutput(candidate.url, prompt, dimensions)
          if (classification === 'invalid') throw new Error('Perchance webpage failed to prepare the requested prompt or size (site initialization error). Retry after the official page has loaded; no result was saved')
          if (classification !== 'output') continue
          const value = await this.evaluate(candidate, perchancePage('collect', '', baseline, dimensions), signal)
          if (typeof value.png === 'string') { this.refresh.add(sessionId); return { ...value, style: prepared.styleLabel } }
          if (value.challenge === true) throw new Error('Perchance requested verification during generation; complete it in the dedicated Sidebar tab then retry')
        }
        await delay(1000, undefined, { signal })
      }
      signal.throwIfAborted()
      throw new Error('Perchance generation interrupted')
    } catch (error) {
      // Once submitted, abandon the entire browsing context so late images cannot
      // satisfy a subsequent tool call. Verification stays visible for the user,
      // with a fresh document required before another generation.
      const verification = error instanceof Error && /verification/i.test(error.message)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Navigation events update the flag while awaiting browser work.
      if (navigated) await this.tabs.clear(sessionId, true)
      else if (submitted && verification && !signal.aborted) this.refresh.add(sessionId)
      else if (submitted || signal.aborted) await this.tabs.clear(sessionId)
      throw error
    } finally {
      guest?.off('did-start-navigation', navigation)
      this.finish(id)
    }
  }
}
