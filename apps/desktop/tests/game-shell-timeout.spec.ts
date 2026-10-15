import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
interface Bridge {
  dispatch: ((id: number, json: string) => void) | null
  request(payload: { command: string }): Promise<unknown>
  respond(id: number, json: string): void
}
afterEach(() => { vi.useRealTimers() })
async function shell() {
  const html = await readFile(new URL('../resources/godot/game-shell.html', import.meta.url), 'utf8')
  const source = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1]
  if (source === undefined) throw new Error('Missing inline game shell')
  const window = { addEventListener() {}, openGame: undefined as Bridge | undefined }
  runInNewContext(source.replace('$GODOT_CONFIG', '{}'), { window, setTimeout, clearTimeout,
    document: { getElementById: () => ({ remove() {} }) },
    Engine: class { async startGame() {} },
  })
  if (window.openGame === undefined) throw new Error('Missing bridge')
  return window.openGame
}
it('executes the production shell and lets a 20-second reproduction finish while ordinary requests still time out at 15 seconds', async () => {
  vi.useFakeTimers()
  const bridge = await shell()
  const ids: number[] = []
  bridge.dispatch = (id) => { ids.push(id) }
  let completed = false
  const long = bridge.request({ command: 'reproduce' }).then((value) => { completed = true; return value })
  const ordinary = bridge.request({ command: 'state' }).then(() => 'unexpected', () => 'timeout')
  await vi.advanceTimersByTimeAsync(16000)
  expect(await ordinary).toBe('timeout')
  expect(completed).toBe(false)
  await vi.advanceTimersByTimeAsync(4000)
  bridge.respond(ids[0]!, '{"trace":[],"deterministic":false}')
  expect(await long).toEqual({ trace: [], deterministic: false })
  expect(vi.getTimerCount()).toBe(0)
})
it('expires reproduction at 75 seconds, ignores late responses and clears the pending timer on a subsequent response', async () => {
  vi.useFakeTimers()
  const bridge = await shell()
  let id = 0
  bridge.dispatch = (value) => { id = value }
  let settled = false
  const result = bridge.request({ command: 'reproduce' }).then(() => 'unexpected', () => { settled = true; return 'timeout' })
  await vi.advanceTimersByTimeAsync(74999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toBe('timeout')
  bridge.respond(id, '{"late":true}')
  expect(vi.getTimerCount()).toBe(0)
  const next = bridge.request({ command: 'state' })
  bridge.respond(id, '{"value":2}')
  expect(await next).toEqual({ value: 2 })
  expect(vi.getTimerCount()).toBe(0)
})
