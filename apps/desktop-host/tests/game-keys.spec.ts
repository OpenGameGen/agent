import { expect, it } from 'vitest'
import { gameKeys, parseGameTest } from '../src/game-tests.ts'
it('validates bounded chords without changing physical names or single-key behavior', () => {
  expect(gameKeys(['w', 'Space'])).toEqual({ keys: ['w', 'Space'], duration_ms: 80 })
  expect(gameKeys(['w'], 0).duration_ms).toBe(0)
  expect(gameKeys(['w'], 10000).duration_ms).toBe(10000)
  for (const keys of [[], ['w', 'w'], Array(9).fill('w'), [''], [3], 'w']) expect(() => gameKeys(keys)).toThrow()
  for (const duration of [-1, 10001, 1.5, '80']) expect(() => gameKeys(['w'], duration)).toThrow()
  const test = parseGameTest('name: chord\nsteps:\n - keys: [w, Space]\n   duration_ms: 200\n - key: Enter\n - assert: {node: /root/Main, property: x, operator: ">", expected: 0}\n')
  expect(test.steps[0]).toEqual({ keys: ['w', 'Space'], duration_ms: 200 })
  expect(test.steps[1]).toEqual({ key: 'Enter' })
})
it('preflights malformed later chords and rejects mixed commands before any input', () => {
  for (const segment of ['keys: []', 'keys: [w, w]', 'keys: [w]\n   duration_ms: 10001', 'keys: [w]\n   key: Space']) {
    expect(() => parseGameTest(`name: invalid\nsteps:\n - key: Enter\n - ${segment}\n`, false)).toThrow('Test step 2')
  }
})
