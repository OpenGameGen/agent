#!/usr/bin/env node
/** Trusted launchers supply a private configuration file; user argv remains literal. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEnvironmentManager } from './runtime.mjs'
import { prepareCreationEnvironment, checkCreationEnvironment } from './setup.mjs'
import { execute, exists } from '../godot/runtime.mjs'

const USAGE = `Agent-managed environments
  agent-env prepare-desktop              Prepare every required creation dependency
  agent-env status                       Inspect paths and versions (no downloads)
  agent-env doctor [all|node|python|blender|godot]
  agent-env ensure <all|node|python|blender|godot|templates>
  agent-env repair <node|python|blender|godot>
  agent-env open blender [Blender arguments]
  agent-env project <directory> --python [--node]

Node.js and Python ship with the desktop. Use the environment manager or fixed Agent tools to prepare missing Blender, Godot and templates on demand. Compatible local installations are reused.
Use npm/pnpm in a project; use project .venv for Python dependencies.
Repair never changes projects. Damaged bundled binaries need a desktop reinstall.
`

/** @param argv - Private launcher prefix and literal user arguments. @returns Command exit code. */
export async function main(argv) {
  if (argv[0] !== '--config' || !argv[1] || argv[2] !== '--mode') throw new Error('Use the desktop-managed launcher')
  const config = JSON.parse(await readFile(argv[1], 'utf8'))
  const lock = JSON.parse(await readFile(join(config.resources, 'lock.json'), 'utf8'))
  const manager = createEnvironmentManager({ ...config, lock })
  const mode = argv[3]
  const args = argv.slice(4)
  if (mode === 'blender') return manager.launchBlender(args)
  if (mode === 'npm' || mode === 'npx') {
    if (args.some(arg => ['-g', '--global', '--location=global'].includes(arg))) throw new Error('Install Node dependencies in the project, without --global')
    return manager.launchNpm(args, mode === 'npx')
  }
  if (mode === 'pnpm') return (await execute(manager.node, [manager.pnpm, ...args])).code
  if (mode === 'python' || mode === 'pip') {
    const venv = process.env.VIRTUAL_ENV ?? join(process.cwd(), '.venv')
    const python = join(venv, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
    const active = await exists(python)
    if (mode === 'pip' && !active) throw new Error('Create project .venv with agent-env project . --python before installing packages')
    const env = { ...process.env, ...(active ? { VIRTUAL_ENV: venv } : {}), PIP_REQUIRE_VIRTUALENV: 'true' }
    return (await execute(active ? python : manager.python, mode === 'pip' ? ['-m', 'pip', ...args] : args, { env })).code
  }
  if (mode !== 'env') throw new Error(`Unknown environment launcher: ${mode}`)
  const [operation, target, ...extra] = args
  if (!operation || ['help', '--help'].includes(operation)) { console.log(USAGE); return 0 }
  if (operation === 'check-desktop' && args.length === 1) { await checkCreationEnvironment(config); return 0 }
  if (operation === 'prepare-desktop' && args.length === 1) {
    const stages = await prepareCreationEnvironment(config, stage => console.error(`Setup-stage: ${JSON.stringify(stage)}`))
    console.log(JSON.stringify(stages)); return 0
  }
  if (operation === 'status' && args.length === 1) { console.log(JSON.stringify(await manager.status(), null, 2)); return 0 }
  if (operation === 'doctor' && args.length <= 2) {
    if (target !== undefined && !['all', 'node', 'python', 'blender', 'godot', 'templates'].includes(target)) throw new Error('Unknown runtime')
    const results = await manager.doctor(target ?? 'all')
    console.log(JSON.stringify(results, null, 2))
    return Object.values(results).every(value => value.healthy) ? 0 : 1
  }
  if (['ensure', 'repair'].includes(operation) && target && extra.length === 0) {
    console.log(JSON.stringify(await manager.ensure(target, operation === 'repair'), null, 2)); return 0
  }
  if (operation === 'open' && target === 'blender') return manager.launchBlender(extra)
  if (operation === 'project' && target && extra.length && extra.every(arg => ['--node', '--python'].includes(arg))) {
    console.log(JSON.stringify(await manager.prepareProject(resolve(target), extra.map(arg => arg.slice(2))), null, 2)); return 0
  }
  throw new Error(USAGE)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
