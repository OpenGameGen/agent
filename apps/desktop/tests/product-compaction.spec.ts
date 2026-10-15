import { mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '../../../packages/compaction/compaction-basic/src/index.ts'
import type { BasicCompactionConfig } from '../../../packages/compaction/compaction-basic/src/types.ts'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { resolveConfig, resolveTargetPolicy, resolveCompactSpec } from '../../../packages/compaction/compaction-basic/src/config.ts'
import { createPluginProfile } from '../src/project-manager.ts'

it('loads product bundle defaults in root and scoped preset with user and reload precedence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'product-compaction-'))
  const dir = join(home, 'profiles', 'desktop')
  const anchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
  try {
    createPluginProfile(dir)
    mkdirSync(join(dir, 'node_modules', '@deepseek-ai'), { recursive: true })
    symlinkSync(fileURLToPath(new URL('../../desktop-host', import.meta.url)), join(dir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host'), 'dir')
    const profile = loadProfileDirectory('test', dir, anchor)
    expect(profile.skippedBundles).toEqual([])
    expect(profile.layers.at(-1)?.packageName).toBe('@deepseek-ai/dsh-desktop-host')
    const context = { name: 'desktop', dir, patchPath: profile.patchPath, home, cwd: dir, installAnchor: anchor,
      overlays: [], startedBundles: profile.layers.map(layer => layer.packageName), telemetryDisabledEnv: undefined }
    const rows = composeEntries([readProfilePatches('test', context)])
    const root = rows.find(row => row.id === 'compaction-basic')
    const preset = rows.find(row => row.id === 'preset-standard')
    const group = (preset?.config as { plugins: EntryOptions[] }).plugins.find(row => row.id === 'compaction')
    const isolated = (group?.config as EntryOptions[]).find(row => row.id === 'compaction-basic')
    expect({ root: root?.config as unknown, scoped: isolated?.config as unknown, isolated: group?.isolate?.['compaction'] }).toMatchInlineSnapshot(`
      {
        "isolated": true,
        "root": {
          "modelPolicies": [
            {
              "headroomTokens": 16384,
              "maxTokens": 8192,
              "model": "nemotron-3.5-lightning-free",
              "provider": "our-free-model",
            },
          ],
        },
        "scoped": {
          "modelPolicies": [
            {
              "headroomTokens": 16384,
              "maxTokens": 8192,
              "model": "nemotron-3.5-lightning-free",
              "provider": "our-free-model",
            },
          ],
        },
      }
    `)
    expect(group?.isolate?.['compaction']).toBe(true)
    expect(isolated?.config as BasicCompactionConfig).toEqual(root?.config)
    const ctx = new Context()
    try {
      for (const plugin of [LlmRuntime, SessionStore, Projections, TokenMeter, Loader]) await ctx.plugin(plugin)
      ctx.loader.builtins.group = Group
      ctx.loader.builtins.auditCompaction = BasicCompaction
      await ctx.plugin(BasicCompaction, root?.config as BasicCompactionConfig)
      const entry = await ctx.loader.create({ name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{
        name: 'cordis:auditCompaction',
        config: isolated?.config as BasicCompactionConfig,
      }] })
      await ctx.loader.await()
      const child = [...ctx.loader.entries()].find(item => item.id === entry)?.fiber?.ctx.get('compaction')
      expect(child).toBeInstanceOf(BasicCompaction)
      expect(child).not.toBe(ctx.compaction)
      expect((child as BasicCompaction).config.modelPolicies).toEqual((ctx.compaction as BasicCompaction).config.modelPolicies)
    } finally { await ctx.fiber.dispose() }
    const config = resolveConfig(isolated?.config as BasicCompactionConfig)
    expect(resolveCompactSpec(resolveTargetPolicy(config, { provider: 'our-free-model', model: 'nemotron-3.5-lightning-free' }), 128000, 32768))
      .toMatchObject({ thresholdTokens: 78848, maxTokens: 8192 })
    expect(resolveTargetPolicy(config, { provider: 'glm-coding', model: 'glm-5.3-flash' })).toMatchObject({ headroomTokens: 65536, maxTokens: 65536 })
    writeFileSync(profile.patchPath, '- preset: preset-standard\n  id: compaction-basic\n  config:\n    auto: false\n    modelPolicies:\n      - provider: our-free-model\n        model: nemotron-3.5-lightning-free\n        headroomTokens: 12345\n')
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: compaction-basic\n  config:\n    auto: false\n')
    const reloaded = composeEntries([readProfilePatches('test', context)])
    expect(reloaded.find(row => row.id === 'compaction-basic')?.config).toEqual({ auto: false })
    const customPreset = reloaded.find(row => row.id === 'preset-standard')?.config as { plugins: EntryOptions[] }
    const customGroup = customPreset.plugins.find(row => row.id === 'compaction')?.config as EntryOptions[]
    const custom = customGroup.find(row => row.id === 'compaction-basic')?.config as BasicCompactionConfig
    expect(custom).toEqual({ auto: false, modelPolicies: [{ provider: 'our-free-model', model: 'nemotron-3.5-lightning-free', headroomTokens: 12345 }] })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('migrates the bundle once without reordering or deleting user entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-bundle-migrate-'))
  try {
    createPluginProfile(dir)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } }; custom?: { retain: boolean } }
    manifest.dsh.profile.bundles = ['custom-before', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'custom-after']
    manifest.custom = { retain: true }
    writeFileSync(path, JSON.stringify(manifest))
    createPluginProfile(dir)
    const once = readFileSync(path, 'utf8')
    createPluginProfile(dir)
    expect(readFileSync(path, 'utf8')).toBe(once)
    expect(JSON.parse(once)).toMatchObject({ custom: { retain: true }, dsh: { profile: { bundles: [
      'custom-before', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-host', 'custom-after',
    ] } } })
    manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', 'custom-only']
    writeFileSync(path, JSON.stringify(manifest))
    const customOnly = readFileSync(path, 'utf8')
    createPluginProfile(dir)
    expect(readFileSync(path, 'utf8')).toBe(customOnly)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
