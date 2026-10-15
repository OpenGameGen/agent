import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { findExternalRuntime } from '../resources/godot/external-runtime.mjs'

it('reuses only the matching version, rejects managed launchers and keeps external files unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-runtimes-'))
  try {
    const old = join(root, 'old-godot')
    const valid = join(root, 'godot')
    const recursive = join(root, 'dsh-runtimes', 'bin', 'godot')
    await mkdir(join(root, 'dsh-runtimes', 'bin'), { recursive: true })
    for (const path of [old, valid, recursive]) await writeFile(path, 'external installation')
    const probe = vi.fn(async (path: string, args: string[]) => {
      expect(args).toEqual(['--headless', '--version'])
      return path === old ? '4.5.stable.official.old' : '4.6.stable.official.build'
    })
    expect(await findExternalRuntime('godot', '4.6.stable', { candidates: [recursive, old, valid], probe })).toBe(valid)
    expect(probe.mock.calls.map(call => call[0])).toEqual([old, valid])
    expect(await findExternalRuntime('godot', '4.6.stable', { candidates: [old], probe })).toBeUndefined()
    expect(await findExternalRuntime('godot', '4.6.stable', { candidates: [valid], excludedRoots: [root], probe })).toBeUndefined()
    const blender = vi.fn(async () => 'Blender 4.5.14 LTS\nBuild date: test')
    expect(await findExternalRuntime('blender', '4.5.14', { candidates: [valid], probe: blender })).toBe(valid)
    expect(await findExternalRuntime('blender', '4.5.14', { candidates: [valid], probe: async () => 'Blender 5.1.2' })).toBe(valid)
    expect(await findExternalRuntime('blender', '4.5.14', { candidates: [valid], probe: async () => 'Blender 3.0.0' })).toBeUndefined()
    expect(await findExternalRuntime('blender', '4.5.14', { candidates: [valid], probe: async () => { throw new Error('broken installation') } })).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
