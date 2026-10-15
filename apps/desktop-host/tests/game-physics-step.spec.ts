import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseGameTest } from '../src/game-tests.ts'

it('validates explicit physics clock only on frame steps and preserves process compatibility', () => {
  const doc = (step: string) => `name: physics\nsteps:\n - ${step}\n - assert: {node: /root/Main, property: ticks, operator: '==', expected: 2}\n`
  expect(parseGameTest(doc('step: 2\n   clock: physics')).steps[0]).toEqual({ step: 2, clock: 'physics' })
  expect(parseGameTest(doc('step: 2')).steps[0]).toEqual({ step: 2 })
  for (const step of ['step: 1\n   clock: wall', 'freeze: true\n   clock: physics', 'step: 1.5\n   clock: physics']) expect(() => parseGameTest(doc(step))).toThrow()
})

const engine = '/Applications/Godot.app/Contents/MacOS/Godot'
it.skipIf(process.platform !== 'darwin' || spawnSync(engine, ['--version']).status !== 0).each([0, 5])('advances exact pausable physics callbacks and 2D/3D solvers at render limit %i', { timeout: 45000 }, async (fps) => {
  const root = await mkdtemp(join(tmpdir(), 'physics-step-'))
  try {
    await cp(new URL('./fixtures/physics-step/', import.meta.url), root, { recursive: true })
    await cp(new URL('../../desktop/resources/godot/game-bridge.gd', import.meta.url), join(root, 'bridge.gd'))
    await writeFile(join(root, 'project.godot'), 'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    const result = spawnSync(engine, ['--headless', '--path', root, '--script', 'res://runner.gd'], { encoding: 'utf8', timeout: 40000, env: { ...process.env, STEP_TEST_FPS: String(fps), HOME: root } })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stderr).not.toMatch(/SCRIPT ERROR|ERROR:/u)
    expect(result.stdout).toContain(`PHYSICS_STEP_OK fps=${fps}`)
    expect(result.stdout.match(/PHYSICS_STEP \{/gu)).toHaveLength(6)
    expect(await readFile(join(root, 'main.gd'), 'utf8')).toContain('RigidBody3D')
  } finally { await rm(root, { recursive: true, force: true }) }
})
