/** Strict input and observed-trajectory comparison for controlled reproduction. */
import { load, JSON_SCHEMA } from 'js-yaml'

/** Project-owned reset and observations; no claim about unobserved state. */
export interface ReproductionTest {
  version: 1
  seed: number
  reset_node: string
  observations: { node: string; property: string }[]
  steps: { actions_down: string[]; actions_up: string[]; physics_ticks: number }[]
}
/** Finite JSON data, including structured vectors encoded by the bridge. */
export type ReproductionValue = null | boolean | number | string | ReproductionValue[] | { [key: string]: ReproductionValue }
/** One initial sample or a sample after a complete input segment. */
export interface ReproductionSample { tick: number; values: ReproductionValue[] }
/** Equality is limited to the supplied observed trajectory. */
export interface ReproductionComparison {
  reproducibility_verified: boolean
  first_difference: { sample: number; tick: number; observation: number; first: ReproductionValue; second: ReproductionValue } | null
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error('Unknown field')
  return result
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Expected bounded nonempty text')
  return value
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected integer ${min}..${max}`)
  return value
}
function array(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Expected array length ${min}..${max}`)
  return value
}
/** @param source - YAML or JSON text, at most 64 KiB. @returns Validated cold-reset test specification. */
export function parseReproductionTest(source: string): ReproductionTest {
  if (Buffer.byteLength(source) > 65536) throw new Error('Reproduction file exceeds 64 KiB')
  const doc = object(load(source, { schema: JSON_SCHEMA }), ['version', 'seed', 'reset_node', 'observations', 'steps'])
  if (doc.version !== 1) throw new Error('version must be 1')
  const actions = (value: unknown) => {
    const names = value === undefined ? [] : array(value, 0, 16).map(item => text(item, 128))
    if (new Set(names).size !== names.length) throw new Error('Duplicate action')
    return names
  }
  const steps = array(doc.steps, 1, 100).map((value) => {
    const step = object(value, ['actions_down', 'actions_up', 'physics_ticks'])
    const actions_down = actions(step.actions_down), actions_up = actions(step.actions_up)
    if (actions_down.length + actions_up.length > 16) throw new Error('At most 16 actions per step')
    if (actions_down.some(name => actions_up.includes(name))) throw new Error('Action cannot be pressed and released in one step')
    return { actions_down, actions_up, physics_ticks: integer(step.physics_ticks, 1, 120) }
  })
  if (!steps.some(step => step.actions_down.length + step.actions_up.length > 0)) throw new Error('At least one input is required')
  if (steps.reduce((sum, step) => sum + step.physics_ticks, 0) > 1200) throw new Error('At most 1200 physics ticks')
  const observations = array(doc.observations, 1, 32).map((value) => {
    const item = object(value, ['node', 'property'])
    return { node: text(item.node, 1024), property: text(item.property, 256) }
  })
  return { version: 1, seed: integer(doc.seed, 0, 2147483647), reset_node: text(doc.reset_node, 1024), observations, steps }
}
function canonical(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 8) throw new Error('Observation nesting exceeds 8')
  if (typeof value === 'string' && value.length > 4096) throw new Error('Observation string exceeds 4096')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Observation must be finite acyclic JSON')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Observation must be plain JSON')
  if ((Array.isArray(value) ? value.length : Object.keys(value).length) > 64) throw new Error('Observation members exceed 64')
  seen.add(value)
  try {
    if (Array.isArray(value)) return '[' + Array.from(value, item => canonical(item, seen, depth + 1)).join(',') + ']'
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item, seen, depth + 1)).join(',') + '}'
  } finally { seen.delete(value) }
}
/**
 * @param test - Validated manifest.
 * @param first - First cold-run wire trace.
 * @param second - Second cold-run wire trace.
 * @returns Exact observed equality or the first differing property; malformed traces throw.
 */
export function compareReproductionTraces(test: ReproductionTest, first: unknown, second: unknown): ReproductionComparison {
  const ticks = [0]
  for (const step of test.steps) ticks.push((ticks[ticks.length - 1] ?? 0) + step.physics_ticks)
  const parse = (trace: unknown) => {
    let totalBytes = 2 + ticks.length - 1 // Outer array brackets and separators.
    return array(trace, ticks.length, ticks.length).map((value, index) => {
      const sample = object(value, ['tick', 'values'])
      if (sample.tick !== ticks[index]) throw new Error('Trace tick does not match manifest')
      const values = array(sample.values, test.observations.length, test.observations.length)
      const normalized = values.map(item => canonical(item, new Set(), 0))
      if (normalized.reduce((sum, item) => sum + Buffer.byteLength(item), 0) > 65536) throw new Error('Sample exceeds 64 KiB')
      const encoded = JSON.stringify({ tick: sample.tick, values: normalized.map(item => JSON.parse(item) as ReproductionValue) })
      totalBytes += Buffer.byteLength(encoded)
      if (totalBytes > 2 * 1024 * 1024) throw new Error('Trace exceeds 2 MiB')
      return { normalized }
    })
  }
  const a = parse(first), b = parse(second)
  for (const [sample, left] of a.entries()) {
    const right = b[sample]
    if (right === undefined) throw new Error('Missing comparison sample')
    for (const [observation, value] of left.normalized.entries()) {
      if (value !== right.normalized[observation]) return { reproducibility_verified: false, first_difference: { sample, tick: ticks[sample] ?? 0, observation, first: JSON.parse(value) as ReproductionValue, second: JSON.parse(right.normalized[observation] ?? 'null') as ReproductionValue } }
    }
  }
  return { reproducibility_verified: true, first_difference: null }
}
