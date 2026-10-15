#!/usr/bin/env node
/** Product CLI: standard Godot argv plus project import/check/run/export workflows. */

import { readFile, readdir, realpath, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime, execute, exists } from './runtime.mjs'
import { projectEnvironment, engineEnvironment } from './user-environment.mjs'
import { ensureLaunchers } from './launchers.mjs'
import { preflightHeadlessScript } from './script-preflight.mjs'

const USAGE = `Managed Godot 4.6
  godot [Godot arguments]                 Standard Godot CLI (auto-installs the engine)
  godot-project status                    Show installed version and paths; no download
  godot-project install [--templates]      Install the engine and optional export templates
  godot-project check <project>            Import assets and parse every GDScript; fail on errors
  godot-project run <project> [arguments]   Run a game; arguments are passed to Godot
  godot-project editor <project>           Open the native Godot editor
  godot-project export <project> <preset> <output> [--debug|--pack]
                                         Import, install templates, and export a game or PCK/ZIP

Projects must contain project.godot. Exports require a named preset in export_presets.cfg.
Engine flags go directly AFTER the project path, without an extra --:
  godot-project run "<project>" --headless --quit-after 120
  godot-project run "<project>" --rendering-method gl_compatibility
A -- separator is passed unchanged to Godot; arguments after it are for your game script, not engine flags.
Use godot-project <command> --help for this help; run <project> --help forwards Godot engine help.
Standard builds support GDScript; C# and mobile exports need additional toolchains.
`

/** @param directory - Candidate project directory. @returns Canonical project path. */
export async function projectPath(directory) {
  if (!directory) throw new Error('Specify a project directory containing project.godot')
  const path = await realpath(resolve(directory))
  if (!await exists(join(path, 'project.godot'))) throw new Error(`No project.godot in ${path}`)
  return path
}

/** @param root - Canonical project. @returns Sorted project-local GDScript paths, excluding links and caches. */
export async function scriptsIn(root) {
  const scripts = []
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink() || ['.godot', '.git', 'node_modules'].includes(item.name)) continue
      const path = join(directory, item.name)
      if (item.isDirectory()) await visit(path)
      else if (item.isFile() && item.name.endsWith('.gd')) scripts.push(path)
    }
  }
  await visit(root)
  return scripts.sort()
}

/**
 * Run explicit project workflows without interpolating any user value into a shell.
 * @param args - Product CLI arguments.
 * @param runtime - Runtime owner; tests use the same API with fixture installations.
 * @returns Process exit code.
 */
export async function projectCommand(args, runtime) {
  const [operation, directory, ...extra] = args
  if (!operation || operation === '--help' || operation === '-h' || operation === 'help') { console.log(USAGE); return 0 }
  if (['status', 'install', 'check', 'run', 'editor', 'export'].includes(operation) && ['--help', '-h'].includes(directory)) { console.log(USAGE); return 0 }
  if (operation === 'status') { console.log(JSON.stringify(await runtime.status(), null, 2)); return 0 }
  if (operation === 'install') {
    if (args.slice(1).some(arg => arg !== '--templates')) throw new Error('Usage: godot-project install [--templates]')
    await runtime.ensureEngine()
    if (args.includes('--templates')) await runtime.ensureTemplates()
    return 0
  }
  if (!['check', 'run', 'editor', 'export'].includes(operation)) throw new Error(`Unknown Godot project command: ${operation}`)
  if (!directory || directory.startsWith('-')) {
    throw new Error(`Usage: godot-project ${operation} <project> [arguments]. Put the project path before flags, e.g. godot-project run "<project>" --headless --quit-after 120. Use godot-project ${operation} --help`)
  }
  const project = await projectPath(directory)
  const engine = await (runtime.requireEngine?.() ?? runtime.ensureEngine())
  const base = ['--path', project]
  const env = await projectEnvironment(project, runtime.templates)
  if (operation === 'run' || operation === 'editor') {
    const checked = await preflightHeadlessScript([...base, ...extra])
    if (checked !== 0) return checked
    return (await execute(engine, [...base, ...(operation === 'editor' ? ['--editor'] : []), ...extra], { env, detectErrors: operation === 'run' })).code
  }
  if (operation === 'check' && extra.length > 0) throw new Error('Usage: godot-project check <project>')
  let preset, output, flag
  if (operation === 'export') {
    const [presetName, outputPath, mode] = extra
    if (!presetName || !outputPath || extra.length > 3 || (mode !== undefined && !['--debug', '--pack'].includes(mode))) {
      throw new Error('Usage: godot-project export <project> <preset> <output> [--debug|--pack]')
    }
    if (!await exists(join(project, 'export_presets.cfg'))) throw new Error('Configure the export preset in export_presets.cfg before exporting')
    const config = await readFile(join(project, 'export_presets.cfg'), 'utf8')
    let inPreset = false
    const names = []
    for (const line of config.split(/\r?\n/u)) {
      if (line.trim().startsWith('[')) inPreset = /^\[preset\.\d+\]$/u.test(line.trim())
      if (inPreset && line.trim().startsWith('name=')) names.push(JSON.parse(line.trim().slice(5)))
    }
    if (!names.includes(presetName)) throw new Error(`Export preset ${JSON.stringify(presetName)} is not configured. Available: ${names.join(', ')}`)
    preset = presetName
    output = isAbsolute(outputPath) ? outputPath : resolve(project, outputPath)
    flag = mode === '--debug' ? '--export-debug' : mode === '--pack' ? '--export-pack' : '--export-release'
  }
  const autoloads = []
  if (operation === 'check') {
    let inAutoload = false
    for (const line of (await readFile(join(project, 'project.godot'), 'utf8')).split(/\r?\n/u)) {
      if (line.trim().startsWith('[')) inAutoload = line.trim() === '[autoload]'
      if (!inAutoload) continue
      const match = /^\s*([A-Za-z_]\w*)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:[;#].*)?$/u.exec(line)
      if (match === null) continue
      try {
        const path = JSON.parse(match[2])
        if (typeof path === 'string' && path.startsWith('res://')) autoloads.push({ name: match[1], path })
      } catch { /* Leave malformed ConfigFile values to Godot's own parser. */ }
    }
  }
  let recentOutput = ''
  let checkCompleted = false
  const hinted = new Set()
  const onOutput = chunk => {
    recentOutput = (recentOutput + chunk).slice(-8192)
    if (recentOutput.includes('OPENGAME_PROJECT_CHECK_COMPLETE')) checkCompleted = true
    for (const entry of autoloads) {
      if (hinted.has(entry.name) || !recentOutput.includes(`Identifier "${entry.name}" not declared in the current scope`)) continue
      hinted.add(entry.name)
      console.error(`Godot hint: project.godot [autoload] ${entry.name}=${JSON.stringify(entry.path)} loads a node without a global singleton. If scripts use ${entry.name} as a global, use ${entry.name}=${JSON.stringify('*' + entry.path)}. Otherwise keep the non-global autoload and access its node explicitly. No files were changed.`)
    }
  }
  const imported = await execute(engine, ['--headless', '--editor', ...base, '--import'], { env, detectErrors: true, timeoutMs: 120000, onOutput, startupProjectConfig: join(project, 'project.godot'), operation: 'Godot asset import' })
  if (imported.code !== 0) return imported.code
  if (operation === 'check') {
    const scripts = (await scriptsIn(project)).map(script => `res://${relative(project, script).split(sep).join('/')}`)
    // check-only compiles before global autoload instances exist and rejects
    // valid singleton references. Load scripts after normal SceneTree startup,
    // without instantiating the main scene or ordinary project scripts.
    const temporary = await mkdtemp(join(project, '.opengame-script-check-'))
    try {
      const manifest = join(temporary, 'scripts.json')
      await writeFile(manifest, JSON.stringify(scripts), { flag: 'wx' })
      checkCompleted = false
      recentOutput = ''
      const outcome = await execute(engine, ['--headless', ...base, '--script', fileURLToPath(new URL('./project-check.gd', import.meta.url)), '--', manifest], { env, detectErrors: true, timeoutMs: 30000, onOutput, operation: 'Godot script check' })
      if (outcome.code !== 0) return outcome.code
      if (!checkCompleted) throw new Error('Script check did not complete; an autoload may have exited the engine before validation')
    } finally { await rm(temporary, { recursive: true, force: true }) }
    console.log('Godot: asset import and GDScript checks passed. Autoloads were initialized; the main scene was not instantiated. Runtime gameplay has not been tested.')
    return 0
  }
  if (flag !== '--export-pack') {
    await runtime.ensureTemplates()
    await projectEnvironment(project, runtime.templates)
  }
  await mkdir(dirname(output), { recursive: true })
  return (await execute(engine, ['--headless', ...base, flag, preset, output], { env, detectErrors: true, timeoutMs: 300000 })).code
}

/** Recognize only the unambiguous product raw import form; preserve every original argument. */
export async function rawImportProjectConfig(args) {
  const separator = args.findIndex(arg => arg === '--' || arg === '++')
  const flags = args.slice(0, separator < 0 ? undefined : separator)
  const required = new Set(['--headless', '--editor', '--import'])
  let directory
  for (let index = 0; index < flags.length; index += 1) {
    const arg = flags[index]
    if (arg === '--path') {
      if (directory !== undefined || !flags[index + 1] || flags[index + 1].startsWith('-')) return undefined
      directory = flags[++index]
    } else if (!required.delete(arg)) return undefined
  }
  if (required.size || directory === undefined) return undefined
  try { return join(await projectPath(directory), 'project.godot') } catch { return undefined }
}

/** @param args - Launcher-owned prefix followed by user argv. @returns Completion exit code. */
export async function main(args) {
  const prefix = args.slice(0, 6)
  if (prefix[0] !== '--runtime' || prefix[2] !== '--python' || prefix[4] !== '--mode'
    || !prefix[1] || !prefix[3] || !['engine', 'project'].includes(prefix[5])) throw new Error('Invoke godot or godot-project through the desktop launcher')
  const lock = JSON.parse(await readFile(new URL('./lock.json', import.meta.url), 'utf8'))
  const runtime = createRuntime({ root: prefix[1], python: prefix[3], lock })
  const userArgs = args.slice(6)
  if (prefix[5] === 'project') {
    const code = await projectCommand(userArgs, runtime)
    if (code === 0 && userArgs[0] === 'install' && !userArgs.some(arg => arg === '--help' || arg === '-h')) {
      await ensureLaunchers({ root: resolve(prefix[1]), node: process.execPath, python: prefix[3], cli: fileURLToPath(import.meta.url) })
    }
    return code
  }
  const executable = await (runtime.requireEngine?.() ?? runtime.ensureEngine())
  // Godot ignores unknown flags; only recognize export flags before the user-argument separator.
  const separator = userArgs.findIndex(arg => arg === '--' || arg === '++')
  if (userArgs.slice(0, separator < 0 ? undefined : separator).some(arg => arg === '--export-release' || arg === '--export-debug')) {
    await runtime.ensureTemplates()
  }
  const env = await engineEnvironment(userArgs, runtime.templates)
  const checked = await preflightHeadlessScript(userArgs)
  if (checked !== 0) return checked
  const startupProjectConfig = await rawImportProjectConfig(userArgs)
  return (await execute(executable, userArgs, { env, startupProjectConfig, operation: 'Godot raw asset import' })).code
}

// Node resolves module URLs through symlinks, while argv[1] retains the caller's path.
export async function isDirectEntry(entry = process.argv[1]) {
  if (!entry) return false
  try {
    return await realpath(entry) === await realpath(fileURLToPath(import.meta.url))
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}

if (await isDirectEntry()) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => {
    console.error(`Godot: ${error.message}. Retry the command after resolving this problem.`)
    process.exitCode = 1
  })
}
