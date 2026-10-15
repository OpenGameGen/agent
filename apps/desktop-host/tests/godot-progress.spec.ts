import { afterEach, expect, it, vi } from 'vitest'
import type { JobHooks, JobRegistry, JobSpec } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { observeGodotPreparation } from '../src/godot-progress.ts'

afterEach(() => { vi.useRealTimers() })
function fixture() {
  vi.useFakeTimers()
  let text = '', hooks: JobHooks | undefined
  const updateProgress = vi.fn(), append = vi.fn(), cancel = vi.fn()
  const start = vi.fn((spec: JobSpec) => {
    hooks = spec.run({ id: 'godot-prepare-1' as never, updateProgress, append })
    return 'godot-prepare-1'
  })
  const handle = { collected: { stderr: {
    readFrom: (from: number) => ({ text: text.slice(from), nextOffset: text.length, lossy: false }),
  } } } as SubprocessHandle
  const finish = observeGodotPreparation(handle, { start } as unknown as JobRegistry, SessionId('test'), cancel)
  return { start, append, updateProgress, cancel, finish, hooks: () => hooks!, write: (value: string) => { text += value } }
}
it('keeps quick cached preparation out of the jobs UI', () => {
  const f = fixture(); f.finish({ status: 'completed' }); vi.advanceTimersByTime(2000)
  expect(f.start).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})
it('streams only bounded installer stages and real bytes, then settles success', async () => {
  const f = fixture(); f.write('Godot: downloading engine (100 MiB).\n'); vi.advanceTimersByTime(1500)
  expect(f.start.mock.calls[0]![0].owner).toBe('test')
  expect(f.updateProgress).toHaveBeenLastCalledWith('Godot: downloading engine (100 MiB).')
  f.write('Godot: downloaded 32 / 100 MiB.\nnot an installer stage\nGodot: verify'); vi.advanceTimersByTime(500)
  expect(f.updateProgress).toHaveBeenLastCalledWith('Godot: downloaded 32 / 100 MiB.')
  f.write('ing engine.\n'); vi.advanceTimersByTime(500)
  expect(f.updateProgress).toHaveBeenLastCalledWith('Godot: verifying engine.')
  f.finish({ status: 'completed' }); await expect(f.hooks().done).resolves.toEqual({ status: 'completed' })
  expect(vi.getTimerCount()).toBe(0)
})
it.each(['failed', 'killed'] as const)('settles %s and forwards job cancellation', async (status) => {
  const f = fixture(); vi.advanceTimersByTime(1500); f.hooks().cancel(); expect(f.cancel).toHaveBeenCalledOnce()
  f.finish({ status }); await expect(f.hooks().done).resolves.toEqual({ status })
  expect(vi.getTimerCount()).toBe(0)
})
it('does not crash installation if the optional progress surface rejects admission', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const f = fixture(); f.start.mockImplementation(() => { throw new Error('owner disposed') })
    expect(() => { vi.advanceTimersByTime(1500) }).not.toThrow()
    f.finish({ status: 'failed' }); expect(warning).toHaveBeenCalledOnce()
  } finally { warning.mockRestore() }
})
