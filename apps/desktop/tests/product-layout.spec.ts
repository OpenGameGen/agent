import { mkdirSync, symlinkSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

it('hides left navigation and closes the right workspace through the desktop profile bundle', () => {
  const home = mkdtempSync(join(tmpdir(), 'product-layout-'))
  const dir = join(home, 'profiles', 'desktop')
  const anchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
  try {
    createPluginProfile(dir)
    appendFileSync(join(dir, 'cordis.patch.yml'), '- id: session-log-deepseek\n  config:\n    enabled: true\n')
    mkdirSync(join(dir, 'node_modules', '@deepseek-ai'), { recursive: true })
    symlinkSync(fileURLToPath(new URL('../../desktop-host', import.meta.url)), join(dir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host'), 'dir')
    const profile = loadProfileDirectory('test', dir, anchor)
    const rows = composeEntries([readProfilePatches('test', {
      name: 'desktop', dir, patchPath: profile.patchPath, home, cwd: dir, installAnchor: anchor,
      overlays: [], startedBundles: profile.layers.map(layer => layer.packageName), telemetryDisabledEnv: undefined,
    })])
    expect(rows.find(row => row.id === 'ui-agent-preset')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-engine-product')?.name).toBe('@deepseek-ai/dsh-client-ui-engine-product')
    expect(rows.find(row => row.id === 'agent-preset-registry')?.config).toMatchObject({ default: 'general' })
    // A previously saved opt-in does not mount the disabled upload contributor.
    expect(rows.find(row => row.id === 'session-log-deepseek')).toMatchObject({ disabled: true, config: { enabled: true } })
    expect(rows.find(row => row.id === 'ui-settings-session-log')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-layout')?.config).toMatchObject({ sidebarInitiallyCollapsed: true })
    expect(rows.find(row => row.id === 'ui-sidebar-right')?.config).toMatchObject({ initiallyExpanded: false })
  } finally { rmSync(home, { recursive: true, force: true }) }
})
