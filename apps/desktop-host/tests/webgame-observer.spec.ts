import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { WEBGAME_OBSERVER } from '../src/webgame-observer.ts'

it('pauses animation loops, excludes planning time, preserves cancellation and allows native observation frames', () => {
  let now = 100
  let sequence = 0
  const queued = new Map<number, (time: number) => void>()
  const scope = { performance: { now: () => now }, addEventListener: () => {},
    requestAnimationFrame: (callback: (time: number) => void) => { const id = ++sequence; queued.set(id, callback); return id },
    cancelAnimationFrame: (id: number) => { queued.delete(id) } }
  const clock = runInNewContext(WEBGAME_OBSERVER + ';__webGamePreviewClock', scope) as {
    freeze(): { frozen: boolean }
    thaw(): { frozen: boolean }
    nextFrame(callback: (time: number) => void): void
  }
  const tick = (time: number) => {
    now = time
    const work = [...queued.values()]
    queued.clear()
    for (const callback of work) callback(time)
  }
  const timestamps: number[] = []
  const loop = (time: number) => { timestamps.push(time); scope.requestAnimationFrame(loop) }
  scope.requestAnimationFrame(loop)
  tick(110)
  expect(clock.freeze().frozen).toBe(true)
  tick(120)
  tick(10120)
  expect(timestamps).toEqual([110])
  let observed = false
  clock.nextFrame(() => { observed = true })
  tick(10130)
  expect(observed).toBe(true)
  expect(clock.thaw().frozen).toBe(false)
  tick(10140)
  expect(timestamps).toEqual([110, 120])
  const cancelled = scope.requestAnimationFrame(() => { throw new Error('cancelled callback ran') })
  scope.cancelAnimationFrame(cancelled)
  tick(10150)
  expect(timestamps).toEqual([110, 120, 130])
})
