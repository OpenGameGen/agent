/** Bounded declarative game assertions and ordered test steps. */
import { load, JSON_SCHEMA } from 'js-yaml'
import { setTimeout as delay } from 'node:timers/promises'

/** @param value - Wire or YAML value. @returns Plain record or a precise refusal. */
export function gameRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a game object')
  return value as Record<string, unknown>
}
/** @param value - YAML or tool string. @returns Bounded text. */
export function gameString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error('Expected nonempty game text')
  return value
}
/** Validate an entire physical-key chord before any input can be delivered. */
export function gameKeys(keys: unknown, duration: unknown = 80): { keys: string[]; duration_ms: number } {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8) throw new Error('keys must be an array of 1..8 physical browser keys')
  const names = keys.map((key: unknown) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) throw new Error('Each key must be physical browser key text of 1..128 characters, e.g. w or Space')
    return key
  })
  if (new Set(names).size !== names.length) throw new Error('keys must not contain duplicate names')
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0 || duration > 10000) throw new Error('keys duration_ms must be an integer in 0..10000')
  return { keys: names, duration_ms: duration }
}
/** @param actual - Observed value. @param operator - Closed comparison set. @param expected - JSON scalar. @returns Assertion outcome. */
export function gameCompare(actual: unknown, operator: string, expected: unknown): boolean {
  if (operator === '==') return JSON.stringify(actual) === JSON.stringify(expected)
  if (operator === '!=') return JSON.stringify(actual) !== JSON.stringify(expected)
  if (typeof actual !== 'number' || typeof expected !== 'number') throw new Error('Ordered assertions require numbers')
  switch (operator) {
    case '>': return actual > expected
    case '>=': return actual >= expected
    case '<': return actual < expected
    case '<=': return actual <= expected
    default: throw new Error('Unsupported assertion operator')
  }
}
/** @param source - Bounded YAML text.
 * @param requireObservation - Tests require observations; input-only replay is explicitly unverified.
 * @returns Validated steps before any interaction executes. */
export function parseGameTest(source: string, requireObservation = true): { name: string; steps: Record<string, unknown>[] } {
  if (Buffer.byteLength(source) > 65536) throw new Error('Test file exceeds 64 KiB')
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field}: expected an object (YAML mapping)`)
    return value as Record<string, unknown>
  }
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
      throw new Error(`${field}: expected a nonempty string of at most 4096 characters${field === 'key' ? '; use a physical key, e.g. key: ArrowRight with duration_ms: 200 at the same indentation, not an InputMap action such as ui_right or a nested key object' : ''}`)
    }
    return value
  }
  const doc = object(load(source, { schema: JSON_SCHEMA }), 'Test document')
  const name = text(doc.name, 'name')
  if (doc.incomplete_recording === true) throw new Error('Recording exceeded its step/size limit; review and split the YAML before replay')
  if (!Array.isArray(doc.steps) || doc.steps.length === 0 || doc.steps.length > 100) throw new Error('steps: expected an array of 1..100 steps')
  const watches = new Set<string>()
  const steps = doc.steps.map((value, index) => {
    try {
      const step = object(value, 'step')
      const commands = ['click_ui', 'click', 'key', 'keys', 'assert', 'wait_node', 'watch_signal', 'wait_signal', 'screenshot', 'wait_ms', 'freeze', 'thaw', 'step']
      const formatHint = 'Use YAML command keys directly, not action/args or game_* tool names. Example:\n'
        + 'name: movement\nsteps:\n  - key: Right\n    duration_ms: 200\n'
        + '  - assert: {node: /root/Player, property: position.x, operator: ">", expected: 10}\n'
        + 'Replace the example node and expected value with your game_tree path and observed baseline.'
      if (commands.filter(key => key in step).length !== 1) throw new Error(`Expected one command (${commands.join(', ')}). ${formatHint}`)
      const unknownFields = Object.keys(step).filter(key => ![...commands, 'duration_ms', 'timeout_ms', 'clock'].includes(key))
      if (unknownFields.length > 0) throw new Error(`Unknown test step field(s): ${unknownFields.join(', ')}. Expected one command and its supported duration_ms/timeout_ms/clock. ${formatHint}`)
      if ('keys' in step) gameKeys(step.keys, step.duration_ms ?? 80)
      for (const key of ['click_ui', 'key', 'wait_node', 'screenshot']) if (key in step) text(step[key], key)
      if ('clock' in step && (!('step' in step) || !['process', 'physics'].includes(String(step.clock)))) throw new Error('clock requires step and must be process or physics')
      if ('duration_ms' in step && !('key' in step || 'keys' in step)) throw new Error('duration_ms requires key or keys')
      if ('timeout_ms' in step && !('wait_node' in step || 'wait_signal' in step || 'assert' in step)) throw new Error('timeout_ms requires a wait command or assert')
      for (const key of ['duration_ms', 'timeout_ms']) if (key in step && (typeof step[key] !== 'number' || !Number.isFinite(step[key]) || step[key] < 0 || step[key] > 10000)) throw new Error(`${key} must be 0..10000 (finite number)`)
      for (const key of ['freeze', 'thaw']) if (key in step && step[key] !== true) throw new Error(`${key} must be true`)
      if ('wait_ms' in step && (typeof step.wait_ms !== 'number' || !Number.isSafeInteger(step.wait_ms) || step.wait_ms < 0 || step.wait_ms > 10000)) throw new Error('wait_ms must be 0..10000 (integer)')
      if ('step' in step && (typeof step.step !== 'number' || !Number.isSafeInteger(step.step) || step.step < 1 || step.step > 120)) throw new Error('step must be 1..120 (integer)')
      if ('click' in step) {
        const point = object(step.click, 'click')
        for (const key of ['x', 'y']) if (typeof point[key] !== 'number' || !Number.isFinite(point[key]) || point[key] < 0 || point[key] > 32768) throw new Error(`click.${key}: expected a finite number in 0..32768 (nonnegative x/y)`)
      }
      for (const key of ['watch_signal', 'wait_signal']) if (key in step) {
        const signal = object(step[key], key); text(signal.node, `${key}.node`); text(signal.signal, `${key}.signal`)
        const identity = JSON.stringify([signal.node, signal.signal])
        if (key === 'watch_signal') watches.add(identity)
        else if (!watches.has(identity)) throw new Error('wait_signal: matching watch_signal must precede input and wait_signal')
      }
      if ('assert' in step) {
        if ('timeout_ms' in step && !Number.isSafeInteger(step.timeout_ms)) throw new Error('assert timeout_ms must be an integer')
        const assertion = object(step.assert, 'assert')
        text(assertion.node, 'assert.node'); text(assertion.property, 'assert.property')
        if (assertion.expected !== null && !['string', 'number', 'boolean'].includes(typeof assertion.expected)) throw new Error('assert.expected: expected one scalar (string, finite number, boolean or null)')
        if (typeof assertion.expected === 'number' && !Number.isFinite(assertion.expected)) throw new Error('assert.expected: expected number must be finite')
        if (['>', '>=', '<', '<='].includes(String(assertion.operator)) && typeof assertion.expected !== 'number') throw new Error('assert.expected: ordered assertions require numbers')
        if (!['==', '!=', '>', '>=', '<', '<='].includes(text(assertion.operator, 'assert.operator')) || !('expected' in assertion)) throw new Error('assert.operator: expected ==, !=, >, >=, < or <=; assert.expected is required')
      }
      return step
    } catch (error) {
      throw new Error(`Test step ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (requireObservation && !steps.some(step => 'assert' in step || 'wait_signal' in step || 'wait_node' in step)) {
    throw new Error('A test needs an assertion or observed signal/node condition; input and screenshots alone cannot pass')
  }
  return { name, steps }
}

/** Observe a condition once or within a bounded window; never replays input. */
export async function observeGameAssertion(
  read: (signal: AbortSignal) => Promise<Record<string, unknown>>, args: Record<string, unknown>, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeout = args.timeout_ms ?? 0
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > 10000) throw new Error('assert timeout_ms must be an integer in 0..10000')
  signal.throwIfAborted()
  const started = performance.now()
  const deadline = timeout > 0 ? AbortSignal.timeout(timeout) : undefined
  const bounded = deadline === undefined ? signal : AbortSignal.any([signal, deadline])
  let first: Record<string, unknown> | undefined
  let last: Record<string, unknown> | undefined
  let attempts = 0
  let passed = false
  while (true) {
    signal.throwIfAborted()
    if (timeout > 0 && performance.now() - started >= timeout) break
    let onAbort: (() => void) | undefined
    try {
      bounded.throwIfAborted()
      // Even a transport that delays cancellation cannot extend the overall window.
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          const reason: unknown = bounded.reason
          reject(reason instanceof Error ? reason : new Error(String(reason)))
        }
        bounded.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([read(bounded), interrupted])
      bounded.throwIfAborted()
      if (timeout > 0 && performance.now() - started >= timeout) break
      attempts++
      first ??= result
      last = result
      passed = gameCompare(result.value, gameString(args.operator), args.expected)
      if (passed || timeout === 0) break
      await delay(Math.min(100, Math.max(0, timeout - (performance.now() - started))), undefined, { signal: bounded })
    } catch (error) {
      signal.throwIfAborted()
      if (deadline?.aborted && (error === bounded.reason || error instanceof Error && error.name === 'AbortError')) break
      throw error
    } finally { if (onAbort !== undefined) bounded.removeEventListener('abort', onAbort) }
  }
  if (last === undefined) throw new Error('Assertion deadline expired before any state observation completed; condition is unverified')
  return { passed, status: passed ? 'passed' : 'failed', mode: timeout === 0 ? 'immediate' : 'eventual',
    timeout_ms: timeout, timed_out: !passed && timeout > 0, attempts, elapsed_ms: Math.round(performance.now() - started),
    first_actual: first?.value, last_actual: last.value, actual: last.value, first_observed_at: first?.observed_at,
    observed_at: last.observed_at, observation_clock: last.observation_clock, expected: args.expected,
    operator: args.operator, node: args.node, property: args.property,
    temporal_context: timeout === 0 ? 'One instantaneous observation.' : 'Condition was sampled within this window. A match does not establish immediate success, continuous truth, event latency or causation.',
    ...(!passed ? { next_action: 'The game assertion failed. Inspect actual versus expected, fix the game or test preconditions, and rerun; do not report this behavior as verified.' } : {}) }
}
