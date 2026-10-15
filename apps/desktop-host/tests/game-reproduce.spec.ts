import { expect, it } from 'vitest'
import { compareReproductionTraces, parseReproductionTest } from '../src/game-reproduce.ts'
const input = () => ({ version: 1, seed: 0, reset_node: '/root/Main', observations: [{ node: '/root/Main', property: 'position.x' }], steps: [{ actions_down: ['ui_right'], physics_ticks: 2 }] })
const parse = (value: object) => parseReproductionTest(JSON.stringify(value))
const trace = (value: unknown) => [{ tick: 0, values: [0] }, { tick: 2, values: [value] }]
it('accepts bounded reset/physics manifests and canonicalizes object keys without sorting arrays', () => {
  const test = parse(input())
  expect(test.steps[0]?.actions_up).toEqual([])
  expect(compareReproductionTraces(test, trace({ x: 1, y: [2, 3] }), trace({ y: [2, 3], x: 1 })).reproducibility_verified).toBe(true)
  expect(compareReproductionTraces(test, trace([2, 3]), trace([3, 2])).first_difference)
    .toMatchObject({ sample: 1, tick: 2, observation: 0 })
})
it('rejects malformed manifests, unbounded inputs and unknown fields', () => {
  const good = input()
  const invalid = [
    {}, { ...good, extra: true }, { ...good, version: 2 }, ...[-1, 2147483648, 1.5].map(seed => ({ ...good, seed })),
    { ...good, reset_node: ' ' }, { ...good, reset_node: 'x'.repeat(1025) },
    ...[[], Array(33).fill(good.observations[0]), [{ node: '/root', property: 'x'.repeat(257) }], [{ node: '/root', property: 'x', extra: 1 }]].map(observations => ({ ...good, observations })),
    ...[[], Array(101).fill(good.steps[0]), [{ physics_ticks: 2 }], [{ physics_ticks: 0, actions_down: ['a'] }], [{ physics_ticks: 121, actions_down: ['a'] }], Array(11).fill({ physics_ticks: 120, actions_down: ['a'] }),
      [{ physics_ticks: 1, actions_down: ['a', 'a'] }], [{ physics_ticks: 1, actions_down: ['a'], actions_up: ['a'] }],
      [{ physics_ticks: 1, actions_down: Array.from({ length: 17 }, (_, i) => String(i)) }], [{ physics_ticks: 1, actions_down: [' '] }], [{ physics_ticks: 1, actions_down: ['x'.repeat(129)] }], [{ physics_ticks: 1, actions_down: ['a'], wait_ms: 1 }]].map(steps => ({ ...good, steps })),
  ]
  for (const value of invalid) expect(() => parse(value)).toThrow()
  expect(() => parseReproductionTest('x'.repeat(65537))).toThrow()
  expect(() => parseReproductionTest('version: [')).toThrow()
})
it('rejects malformed and non-finite traces even when an earlier sample differs', () => {
  const test = parse(input())
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  let deep: unknown = 1; for (let i = 0; i < 10; i++) deep = [deep]
  for (const bad of [
    NaN, Infinity, undefined, cycle, new Date(), deep, Array(65).fill(0),
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, 0])), 'x'.repeat(4097),
  ]) expect(() => compareReproductionTraces(test, trace(0), trace(bad))).toThrow()
  for (const bad of [
    [], [{ tick: 0, values: [0] }], [{ tick: 0, values: [0] }, { tick: 3, values: [0] }],
    [{ tick: 0, values: [0], extra: true }, { tick: 2, values: [0] }],
    [{ tick: 0, values: [0] }, { tick: 2, values: [] }],
  ]) expect(() => compareReproductionTraces(test, trace(0), bad)).toThrow()
})
it('bounds total trace payload', () => {
  const test = parse({ ...input(), steps: Array.from({ length: 100 }, () => ({ actions_down: ['a'], physics_ticks: 1 })) })
  const huge = Array.from({ length: 101 }, (_, tick) => ({ tick, values: [Array(8).fill('x'.repeat(4096))] }))
  expect(() => compareReproductionTraces(test, huge, huge)).toThrow('2 MiB')
})

it('includes outer array punctuation in the exact 2 MiB trace limit', () => {
  const test = parse({ ...input(), steps: Array.from({ length: 100 }, () => ({ actions_down: ['a'], physics_ticks: 1 })) })
  const samples = Array.from({ length: 101 }, (_, tick) => ({ tick, values: [Array<string>(8).fill('')] }))
  let remaining = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(samples))
  for (const sample of samples) {
    const strings = sample.values[0]
    if (strings === undefined) throw new Error('Missing fixture values')
    for (let i = 0; i < strings.length && remaining > 0; i++) {
      const length = Math.min(4096, remaining)
      strings[i] = 'x'.repeat(length)
      remaining -= length
    }
  }
  expect(remaining).toBe(0)
  expect(Buffer.byteLength(JSON.stringify(samples))).toBe(2 * 1024 * 1024)
  expect(compareReproductionTraces(test, samples, samples).reproducibility_verified).toBe(true)
  const last = samples.at(-1)?.values[0]
  if (last === undefined) throw new Error('Missing fixture tail')
  last[0] = `${last[0]}x`
  expect(Buffer.byteLength(JSON.stringify(samples))).toBe(2 * 1024 * 1024 + 1)
  expect(() => compareReproductionTraces(test, samples, samples)).toThrow('2 MiB')
})
