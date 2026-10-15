/** MCP resource ownership in the shipped Desktop composition. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

it('retains one shared resource consumer in the Desktop Web profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-mcp-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ], message => warnings.push(message))

    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-resources')).toEqual([
      { id: 'mcp-resources', name: '@deepseek-ai/dsh-mcp-resources' },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
    expect(rows.find(row => row.id === 'webserver')).toMatchObject({ name: '@deepseek-ai/dsh-host-webserver' })
    expect(rows.find(row => row.id === 'webserver')?.disabled).not.toBe(true)
    expect(warnings).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('seeds the free model once and lets a user model selection survive the product overlay', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-model-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const overlay = fileURLToPath(new URL('../resources/environments/desktop.patch.yml', import.meta.url))
    createPluginProfile(profileDir)
    expect(readFileSync(patchPath, 'utf8')).toContain('model: free-auto')
    writeFileSync(patchPath, '# Existing profile has no overrides.\n[]\n')
    createPluginProfile(profileDir)
    expect(readFileSync(patchPath, 'utf8')).toContain('model: free-auto')
    const custom = '- id: agent-default-model\n  config:\n    provider: glm-coding\n    model: glm-5.3-flash\n'
    writeFileSync(patchPath, custom)
    createPluginProfile(profileDir)
    expect(readFileSync(patchPath, 'utf8')).toBe(custom)
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, loadOverlayPatches('test', overlay)])
    expect(rows.find(row => row.id === 'agent-default-model')?.config).toEqual({ provider: 'glm-coding', model: 'glm-5.3-flash' })
  } finally { rmSync(home, { recursive: true, force: true }) }
})
