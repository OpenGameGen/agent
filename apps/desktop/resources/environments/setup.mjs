/** Desktop-owned preparation before the supported profile can start. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createEnvironmentManager } from './runtime.mjs'
import { createRuntime, execute } from '../godot/runtime.mjs'

/**
 * Check actual versions on every launch and repair only downloaded dependencies.
 * @param config - Private launcher configuration written by Desktop.
 * @param notify - Receives stage and outcome; no user-selected commands or URLs.
 * @returns Successful stage outcomes, only after all checks pass.
 */
export async function prepareCreationEnvironment(config, notify) {
  const lock = JSON.parse(await readFile(join(config.resources, 'lock.json'), 'utf8'))
  const manager = createEnvironmentManager({ ...config, lock })
  const stages = []
  for (const target of ['node', 'python', 'godot', 'blender']) {
    notify({ target, phase: 'checking' })
    const health = (await manager.doctor(target))[target]
    // Bundled interpreters are repaired by reinstalling Desktop; downloaded engines
    // stage their replacement before retaining and replacing the previous directory.
    if (!health.healthy && ['node', 'python'].includes(target)) throw new Error(health.error)
    let repair = !health.healthy
    if (target === 'node') { try { await checkNpm(manager, lock) } catch { repair = true } }
    notify({ target, phase: repair ? 'installing' : 'reusing' })
    await manager.ensure(target, repair)
    if (target === 'node') await checkNpm(manager, lock)
    const checked = (await manager.doctor(target))[target]
    if (!checked.healthy) throw new Error(checked.error)
    const stage = { target, phase: 'ready', reused: !repair }
    stages.push(stage)
    notify(stage)
  }
  notify({ target: 'templates', phase: 'checking' })
  const godot = createRuntime({ platform: config.platform, arch: config.arch, home: config.godotHome, root: config.godotRoot, resources: config.godotResources, python: manager.python,
    lock: JSON.parse(await readFile(join(config.godotResources, 'lock.json'), 'utf8')) })
  let ready = false
  let repair = false
  try { const state = await godot.status(); ready = state.templatesInstalled; repair = state.templatesNeedRepair === true }
  catch (error) {
    // Incomplete or mismatched templates remain untouched until a verified replacement exists.
    repair = true
    console.error(`Setup: templates need repair: ${error.message}`)
  }
  notify({ target: 'templates', phase: ready ? 'reusing' : 'installing' })
  await godot.ensureTemplates(repair)
  if (!(await godot.status()).templatesInstalled) throw new Error('Godot export templates were not installed')
  const stage = { target: 'templates', phase: 'ready', reused: ready }
  stages.push(stage)
  notify(stage)
  return stages
}

/** Read-only startup health check: never installs or downloads components. */
export async function checkCreationEnvironment(config) {
  const lock = JSON.parse(await readFile(join(config.resources, 'lock.json'), 'utf8'))
  const manager = createEnvironmentManager({ ...config, lock })
  const health = await manager.doctor('all')
  for (const [target, result] of Object.entries(health)) if (!result.healthy) throw new Error(`${target}: ${result.error}`)
  await checkNpm(manager, lock)
  const godot = createRuntime({ platform: config.platform, arch: config.arch, home: config.godotHome, root: config.godotRoot, resources: config.godotResources, python: manager.python,
    lock: JSON.parse(await readFile(join(config.godotResources, 'lock.json'), 'utf8')) })
  if (!(await godot.status()).templatesInstalled) throw new Error('Godot export templates are missing')
}

async function checkNpm(manager, lock) {
  const state = await manager.status()
  if (!state.packageManagers.npmInstalled) throw new Error('npm is missing')
  const npm = await execute(state.node.executable, [state.packageManagers.npm, '--version'], { quiet: true, timeoutMs: 10000 })
  if (npm.code !== 0 || npm.output.trim() !== lock.npm.version) throw new Error('npm is damaged or has an unexpected version')
}
