/** Session-safe staging through the public preset selection API. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Product choices and the corresponding host preset identifiers. */
export const ENGINES = [
  { id: 'general', label: '通用' },
  { id: 'godot', label: 'Godot' },
] as const
/** Observable selector readiness, selection and error state. */
export interface State { current: string; busy: boolean; ready: boolean; error: string | null }

/** One visible seat, with an optional pick staged before a draft exists. */
export class EngineController {
  /** Selector snapshots; subscribers dispose their own subscriptions. */
  readonly store = createSnapshotStore<State>({ current: 'general', busy: false, ready: false, error: null })
  private staged: string | undefined
  private fallback = 'general'

  constructor(private ctx: Context, private sessionId: SessionId | undefined) {}

  /** Load available presets and synchronize selection; failures appear in the store. */
  async load(): Promise<void> {
    try {
      const result = await this.ctx.remote.agentPresets.list()
      if (!result.ok) throw new Error(result.error.message)
      const missing = ENGINES.filter(engine => !result.value.presets.some(p => p.id === engine.id && p.broken === undefined))
      if (missing.length) throw new Error('引擎 Agent 尚未就绪：' + missing.map(engine => engine.label).join('、'))
      const defaultId = result.value.presets.find(preset => preset.isDefault)?.id
      this.fallback = ENGINES.some(engine => engine.id === defaultId) ? (defaultId ?? 'general') : 'general'
      this.store.set({ ...this.store.getSnapshot(), ready: true, error: null })
      await this.sync()
    } catch (error) { this.fail(error) }
  }

  /** Stage a supported preset and apply it to a blank session.
   * @param id - Product preset identifier.
   */
  async select(id: string): Promise<void> {
    const state = this.store.getSnapshot()
    if (!ENGINES.some(engine => engine.id === id) || state.busy || !state.ready) return
    this.staged = id
    this.store.set({ ...state, current: id, error: null })
    await this.sync()
  }

  /** Apply staged/default choices only to blank sessions, preserving started sessions. */
  async sync(): Promise<void> {
    if (this.store.getSnapshot().busy) return
    const summaries = this.ctx.sessions.list.getSnapshot().byId
    const session = this.sessionId === undefined
      ? Object.values(summaries).find(summary => summary.blank
        && (this.ctx.sessions.retainInfo(summary.id).getSnapshot().retainedBy.mainView ?? 0) > 0)
      : summaries[this.sessionId]
    const actual = session?.projectionValues?.agentPreset
    const current = typeof actual === 'string' ? actual : this.fallback
    // Only migrate unused legacy drafts. Started Standard/Three.js sessions stay intact.
    if (this.staged === undefined && session?.blank && (actual === 'standard' || actual === 'threejs') && this.store.getSnapshot().ready) {
      this.staged = this.fallback
    }
    if (this.staged === undefined) {
      const state = this.store.getSnapshot()
      if (state.current !== current) this.store.set({ ...state, current })
      return
    }
    if (session === undefined) return
    const target = this.staged
    this.staged = undefined
    if (!session.blank) {
      this.store.set({ ...this.store.getSnapshot(), current, error: '开始对话后不能切换引擎，请新建对话。' })
      return
    }
    if (current === target) return
    this.store.set({ ...this.store.getSnapshot(), busy: true })
    try {
      const result = await this.ctx.remote.agentPresets.select(session.id, target)
      if (!result.ok) throw new Error(result.error.message)
      this.store.set({ ...this.store.getSnapshot(), current: result.value, error: null })
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), current })
      this.fail(error)
    } finally { this.store.set({ ...this.store.getSnapshot(), busy: false }) }
  }

  private fail(error: unknown): void {
    this.store.set({ ...this.store.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
  }
}
