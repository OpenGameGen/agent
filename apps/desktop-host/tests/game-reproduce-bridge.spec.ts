import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
const engine = '/Applications/Godot.app/Contents/MacOS/Godot'
it.skipIf(process.platform !== 'darwin' || spawnSync(engine, ['--version']).status !== 0)('compares true cold processes and exercises the project reset and cleanup contract', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'reproduce-'))
  try {
    await cp(new URL('./fixtures/reproduce/', import.meta.url), root, { recursive: true })
    for (const [source, target] of [['game-bridge.gd', 'bridge.gd'], ['game-reproduce.gd', 'game-reproduce.gd']] as const) await cp(new URL(`../../desktop/resources/godot/${source}`, import.meta.url), join(root, target))
    await writeFile(join(root, 'project.godot'), 'config_version=5\n[autoload]\nGlobal="*res://global.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    const traces = []
    for (const seed of [123, 123, 456]) {
      const result = spawnSync(engine, ['--headless', '--path', root, '--script', 'res://runner.gd'], { encoding: 'utf8', timeout: 8000, env: { ...process.env, HOME: root, REPRO_SEED: String(seed) } })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stderr).not.toMatch(/SCRIPT ERROR|ERROR:/u)
      expect(result.stdout).toContain('REPRO_OK')
      expect(result.stdout).toContain('REPRO_PRECISION_OK')
      const line = result.stdout.split('\n').find(item => item.startsWith('REPRO_TRACE '))
      expect(line).toBeDefined()
      traces.push(JSON.parse(line!.slice('REPRO_TRACE '.length)) as { trace: unknown; deterministic: boolean })
    }
    expect(traces[0]?.trace).toEqual(traces[1]?.trace)
    expect(traces[0]?.trace).not.toEqual(traces[2]?.trace)
    expect(traces[0]?.deterministic).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
