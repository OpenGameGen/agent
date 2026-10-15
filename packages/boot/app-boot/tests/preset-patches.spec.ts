import { expect, it } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'

const rows = () => [
  { id: 'same', name: 'root', config: { value: 'root' } },
  ...['a', 'b'].map(id => ({ id, name: 'declaration', config: { plugins: [
    { id: 'group', name: 'cordis:group', group: true, config: [{ id: 'same', name: 'leaf', config: { value: id } }] },
  ] } })),
]

it('scopes original patch and name-assertion semantics without mutating other declarations or inputs', () => {
  const data = rows()
  const before = structuredClone(data)
  const patches = [{ preset: 'a', id: 'same', name: 'leaf', config: { value: 'product' } }]
  const output = applyEntryPatches(data, patches, () => {})
  expect(output[0]).toEqual(before[0])
  expect(output[2]).toEqual(before[2])
  expect(JSON.stringify(output[1])).toContain('product')
  expect(data).toEqual(before)
  expect(applyEntryPatches(data, patches, () => {})).toEqual(output)
  expect(applyEntryPatches(data, [], () => {})).toEqual(before)
})

it('preserves insert ordering and later user config precedence inside one declaration', () => {
  const output = applyEntryPatches(rows(), [
    { preset: 'a', id: 'group', insert: [{ id: 'new', name: 'leaf' }] },
    { preset: 'a', id: 'new', config: { value: 1 } },
    { preset: 'a', id: 'new', config: { auto: false } },
  ], () => {})
  expect(JSON.stringify(output[1])).toContain('"auto":false')
  expect(JSON.stringify(output[1])).not.toContain('"value":1')
})

it('warns and skips invalid declaration selectors without falling back to a root id', () => {
  const warnings: string[] = []
  const data = rows()
  const output = applyEntryPatches(data, [
    { preset: '', id: 'same', config: 'bad' },
    { preset: 'missing', id: 'same', config: 'bad' },
    { preset: 'same', id: 'same', config: 'bad' },
    { preset: 'a', id: 'same', name: 'wrong', config: 'bad' },
  ], message => warnings.push(message))
  expect(output).toEqual(data)
  expect(warnings).toHaveLength(4)
})

it('rejects nonliteral or malformed plugin lists and keeps patch inputs reusable', () => {
  const invalid = [
    { __jsExpr: 'external()' }, { plugins: {} }, { plugins: [null] },
  ].map((config, index) => ({ id: `invalid${index}`, name: 'declaration', config }))
  const patches = invalid.map(row => ({ preset: row.id, id: 'same', config: { value: 'no' } }))
  const before = structuredClone(patches)
  const warnings: string[] = []
  expect(applyEntryPatches(invalid, patches, message => warnings.push(message))).toEqual(invalid)
  expect(warnings).toHaveLength(3)
  expect(patches).toEqual(before)
  const nested = [{ id: 'outer', name: 'cordis:group', group: true, config: rows() }]
  const changed = applyEntryPatches(nested, [{ preset: 'a', id: 'same', config: { value: 'changed' } }], () => {})
  expect(JSON.stringify(changed)).toContain('changed')
  expect(JSON.stringify(applyEntryPatches(nested, [{ preset: 'a', id: 'same', config: { value: 'new' } }], () => {})))
    .not.toContain('changed')
})
