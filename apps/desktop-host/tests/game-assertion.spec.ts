import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { observeGameAssertion, parseGameTest } from '../src/game-tests.ts'

const args = { node: '/root/Main', property: 'cores', operator: '==', expected: 2 }
const signal = () => new AbortController().signal
const state = (value: number) => ({ value, observed_at: new Date().toISOString(), observation_clock: 'host receive time' })

it('keeps default instantaneous failures and explicitly reports a later match', async () => {
  let reads = 0
  const read = async () => state(++reads)
  const immediate = await observeGameAssertion(read, args, signal())
  expect(immediate).toMatchObject({ passed: false, mode: 'immediate', attempts: 1, first_actual: 1, last_actual: 1, timed_out: false })
  reads = 0
  const eventual = await observeGameAssertion(read, { ...args, timeout_ms: 1000 }, signal())
  expect(eventual).toMatchObject({ passed: true, mode: 'eventual', attempts: 2, first_actual: 1, last_actual: 2, timed_out: false })
  expect(Number(eventual.elapsed_ms)).toBeGreaterThanOrEqual(90)
  expect(eventual.temporal_context).toContain('not establish immediate success')
})

it('bounds timeout across a slow RPC and never accepts its late result', async () => {
  let reads = 0
  const result = await observeGameAssertion(async () => {
    if (++reads === 1) return state(1)
    await delay(500)
    return state(2)
  }, { ...args, timeout_ms: 160 }, signal())
  expect(result).toMatchObject({ passed: false, timed_out: true, attempts: 1, last_actual: 1 })
  expect(Number(result.elapsed_ms)).toBeLessThan(400)
  await expect(observeGameAssertion(async () => { await delay(500); return state(2) }, { ...args, timeout_ms: 30 }, signal())).rejects.toThrow('before any state observation')
})

it('reports bounded repeated false observations as a failed eventual assertion', async () => {
  const result = await observeGameAssertion(async () => state(1), { ...args, timeout_ms: 220 }, signal())
  expect(result).toMatchObject({ passed: false, status: 'failed', mode: 'eventual', timed_out: true, first_actual: 1, last_actual: 1 })
  expect(Number(result.attempts)).toBeGreaterThanOrEqual(2)
  expect(Number(result.elapsed_ms)).toBeLessThan(450)
})

it('does not retry runtime errors and cancels both waiting and pending RPCs', async () => {
  let reads = 0
  await expect(observeGameAssertion(async () => { reads++; throw new Error('Node not found') }, { ...args, timeout_ms: 500 }, signal())).rejects.toThrow('Node not found')
  expect(reads).toBe(1)
  for (const pending of [false, true]) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('user canceled')) }, 20)
    let received: AbortSignal | undefined
    try {
      await expect(observeGameAssertion(async (bounded) => { received = bounded; if (pending) await delay(500); return state(1) }, { ...args, timeout_ms: 500 }, controller.signal)).rejects.toThrow('user canceled')
      expect(received?.aborted).toBe(true)
    } finally { clearTimeout(timer) }
  }
})

it('validates bounded integer timeouts and YAML assert placement before execution', async () => {
  for (const timeout_ms of [-1, 10001, 0.5, '100']) await expect(observeGameAssertion(async () => state(2), { ...args, timeout_ms }, signal())).rejects.toThrow('integer')
  const yaml = 'name: async\nsteps:\n - assert: {node: /root/Main, property: cores, operator: "==", expected: 2}\n   timeout_ms: 1000\n'
  expect(parseGameTest(yaml).steps[0]?.timeout_ms).toBe(1000)
  expect(() => parseGameTest(yaml.replace('1000', '0.5'))).toThrow('integer')
  expect(() => parseGameTest('name: invalid\nsteps:\n - key: Right\n   timeout_ms: 100\n', false)).toThrow('timeout_ms requires')
})
