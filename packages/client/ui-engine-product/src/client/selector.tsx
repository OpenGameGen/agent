/** Independent occupant of the upstream hero preset slot. */
import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { EngineController, ENGINES, type State } from './controller.ts'

interface Injected {
  hooks: { engine: SnapshotStore<State> }
  load: () => Promise<void>
  select: (id: string) => Promise<void>
}
export type EngineSelectorProps = PropsRuntime<'conversation.hero.agentPreset'> & InjectFace<Injected>

/** Only draft sessions expose this choice; a started session keeps its preset. */
export function EngineSelector({ useEngine, load, select }: EngineSelectorProps) {
  const state = useEngine(snapshot => snapshot)
  useEffect(() => { void load() }, [load])
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
    <select aria-label="游戏引擎" title="选择新对话使用的游戏引擎" value={ENGINES.some(engine => engine.id === state.current) ? state.current : 'general'} disabled={!state.ready || state.busy}
      onChange={(event) => { void select(event.target.value) }}
      style={{ font: 'inherit', color: 'inherit', background: 'transparent', border: 0, padding: '4px 6px', cursor: 'pointer' }}>
      {ENGINES.map(engine => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
      {!ENGINES.some(engine => engine.id === state.current) ? <option value={ENGINES.some(engine => engine.id === state.current) ? state.current : 'general'}>通用</option> : null}
    </select>
    {state.error ? <span role="alert" style={{ color: '#b42318', maxWidth: 280 }}>{state.error}</span> : null}
  </span>
}

export const inject = ['slots', 'sessions', 'remote', 'remote.agentPresets']
/** Register a disposable product selector without mounting the upstream mode UI. */
export function apply(ctx: Context): void {
  const seats = new Map<SessionId | undefined, EngineController>()
  ctx.effect(() => {
    const stop = ctx.sessions.list.subscribe(() => {
      for (const seat of seats.values()) void seat.sync()
    })
    return () => { stop(); seats.clear() }
  })
  ctx.slots.inject('conversation.hero.agentPreset', () => ctx.slots.register({
    name: 'conversation.hero.agentPreset',
    inject: (sessionId: SessionId | undefined): Injected => {
      let seat = seats.get(sessionId)
      if (seat === undefined) {
        seat = new EngineController(ctx, sessionId)
        seats.set(sessionId, seat)
        if (sessionId !== undefined) {
          ctx.sessions.binding(sessionId)?.ctx.effect(() => () => { seats.delete(sessionId) })
        }
      }
      const controller = seat
      return { hooks: { engine: controller.store }, load: () => controller.load(), select: id => controller.select(id) }
    },
  }, EngineSelector))
}
