import { findExternalRuntime } from '../godot/external-runtime.mjs'
import { downloadPinned } from '../godot/download.mjs'
/** Product-owned runtime operations. Bundled interpreters are read-only; project code runs in ordinary shells. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRuntime as godotRuntime, execute, exists } from '../godot/runtime.mjs'

export async function downloadAsset(asset, root) {
  return downloadPinned(asset, root)
}

/** @param root - Product-owned directory. @param operation - Serialized installation. @returns Operation result. */
export async function withInstallLock(root, operation) {
  await mkdir(root, { recursive: true })
  const path = join(root, 'install.lock')
  const deadline = Date.now() + 35 * 60 * 1000
  let owner
  while (owner === undefined) {
    try {
      const acquired = await open(path, 'wx', 0o600)
      try { await acquired.writeFile(String(process.pid)) } catch (error) {
        await acquired.close()
        await rm(path, { force: true })
        throw error
      }
      owner = acquired
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const recoveryPath = join(root, 'recovery.lock')
      let recovery
      try { recovery = await open(recoveryPath, 'wx', 0o600) } catch (error) { if (error.code !== 'EEXIST') throw error }
      if (recovery !== undefined) {
        try {
          const pid = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
          if (/^[1-9]\d*$/u.test(pid)) {
            try { process.kill(Number(pid), 0) } catch (error) {
              if (error.code === 'ESRCH') await rm(path, { force: true })
              else if (error.code !== 'EPERM') throw error
            }
          } else if (Date.now() - (await stat(path).catch(error => { if (error.code === 'ENOENT') return { mtimeMs: Date.now() }; throw error })).mtimeMs > 5000) {
            throw new Error(`Invalid environment lock; remove ${path} and retry`)
          }
        } finally { await recovery.close(); await rm(recoveryPath, { force: true }) }
      } else if (Date.now() - (await stat(recoveryPath).catch(error => { if (error.code === 'ENOENT') return { mtimeMs: Date.now() }; throw error })).mtimeMs > 5000) {
        throw new Error(`Interrupted lock recovery; remove ${recoveryPath} and retry`)
      }
      if (Date.now() > deadline) throw new Error(`Environment installation is busy: ${path}`)
      await sleep(250)
    }
  }
  try { return await operation() } finally { await owner.close(); await rm(path, { force: true }) }
}

async function checked(executable, args, options = {}) {
  const result = await execute(executable, args, { quiet: true, timeoutMs: 30000, ...options })
  if (result.code !== 0) throw new Error(`Environment command failed (${result.code}): ${result.output}`)
  return result.output.trim()
}

async function regularDirectory(path) {
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`Environment directory cannot be a filesystem link: ${path}`)
}

/** @param options - Desktop-owned locations, target and release locks. @returns Unified runtime manager. */
export function createEnvironmentManager({ root, primaryRuntime, godotRoot, godotResources, resources, lock,
  platform = process.platform, arch = process.arch }) {
  for (const path of [root, primaryRuntime, godotRoot, godotResources, resources]) {
    if (!isAbsolute(path)) throw new Error('Environment paths must be absolute')
  }
  if (!lock.blender.assets[`${platform}-${arch}`]) throw new Error(`Unsupported environment target: ${platform}/${arch}`)
  const windows = platform === 'win32'
  const node = join(primaryRuntime, 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node')
  const python = join(primaryRuntime, 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']))
  const pnpm = join(primaryRuntime, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  const blenderRoot = join(root, 'blender', lock.blender.version)
  const blender = windows ? join(blenderRoot, `blender-${lock.blender.version}-windows-x64`, 'blender.exe')
    : join(blenderRoot, 'Blender.app', 'Contents', 'MacOS', 'Blender')
  let externalBlender
  const selectedBlender = async () => await (externalBlender ??= findExternalRuntime('blender', lock.blender.version, { platform, excludedRoots: [root, godotRoot] })) ?? blender
  const npmRoot = join(root, 'npm', lock.npm.version)
  const npm = join(npmRoot, 'bin', 'npm-cli.js')
  const manifest = async () => {
    const value = JSON.parse(await readFile(join(primaryRuntime, 'runtime.json'), 'utf8'))
    if (value.platform !== platform || value.arch !== arch) throw new Error('Bundled environment target mismatch')
    const versions = value.components ?? value
    if (![versions.node, versions.python, versions.pnpm].every(value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(value))) throw new Error('Invalid bundled runtime versions')
    return versions
  }
  let godotInstance
  const godot = async () => godotInstance ??= godotRuntime({ root: godotRoot, python, platform, arch, resources: godotResources,
    lock: JSON.parse(await readFile(join(godotResources, 'lock.json'), 'utf8')) })
  const verifyBlender = async path => {
    const output = await checked(path, ['--background', '--factory-startup', '--version'])
    if (!new RegExp(`^Blender ${lock.blender.version.replaceAll('.', '\\.')}(?:\\s|$)`, 'u').test(output)) throw new Error(`Blender executable version mismatch: ${output.split('\n')[0]}`)
    return output.split('\n')[0]
  }
  const install = async (kind, repair = false) => {
    const directory = kind === 'blender' ? blenderRoot : npmRoot
    const executable = kind === 'blender' ? blender : npm
    const verify = async path => {
      if (kind === 'blender') return verifyBlender(path)
      const version = await checked(node, [path, '--version'])
      if (version !== lock.npm.version) throw new Error('npm executable version mismatch')
      return version
    }
    return withInstallLock(dirname(directory), async () => {
      if (!repair && await exists(directory)) {
        await regularDirectory(directory)
        await verify(executable)
        return executable
      }
      const asset = kind === 'blender' ? lock.blender.assets[`${platform}-${arch}`] : lock.npm.asset
      const archive = await downloadAsset(asset, join(root, 'downloads', kind))
      const staging = await mkdtemp(join(dirname(directory), '.staging-'))
      try {
        if (kind === 'npm') {
          await checked(python, ['-B', join(resources, 'extract.py'), archive, staging], { timeoutMs: 120000 })
        } else if (windows) {
          await checked(python, ['-B', join(godotResources, 'extract.py'), archive, staging], { timeoutMs: 120000 })
        } else {
          const mount = await mkdtemp(join(dirname(directory), '.mount-'))
          let attached = false
          try {
            await checked('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, archive], { timeoutMs: 120000 })
            attached = true
            const app = join(mount, 'Blender.app')
            await regularDirectory(app)
            await checked('/usr/bin/ditto', [app, join(staging, 'Blender.app')], { timeoutMs: 120000 })
          } finally {
            if (attached) await checked('/usr/bin/hdiutil', ['detach', mount], { timeoutMs: 30000 })
            await rm(mount, { recursive: true, force: true })
          }
        }
        const relative = executable.slice(directory.length + 1)
        await verify(join(staging, relative))
        await writeFile(join(staging, 'installed.json'), JSON.stringify({ version: kind === 'blender' ? lock.blender.version : lock.npm.version, sha256: asset.sha256 }), { flag: 'wx' })
        const previous = `${directory}.previous-${randomUUID()}`
        const replacing = await exists(directory)
        if (replacing) { await regularDirectory(directory); await rename(directory, previous) }
        try { await rename(staging, directory) } catch (error) {
          if (replacing) await rename(previous, directory)
          throw error
        }
        // Previous versions remain available after repair; running processes may still use them.
        if (replacing) console.error(`Environment: retained previous installation at ${previous}`)
        return executable
      } finally { await rm(staging, { recursive: true, force: true }) }
    })
  }
  const status = async () => {
    const versions = await manifest()
    const g = await (await godot()).status()
    const selected = await selectedBlender()
    const blenderVersion = selected === blender ? lock.blender.version : /^Blender (\d+\.\d+\.\d+)/u.exec(await checked(selected, ['--version']))?.[1] ?? lock.blender.version
    return {
      node: { version: versions.node, executable: node, installed: await exists(node), source: 'bundled' },
      python: { version: versions.python, executable: python, installed: await exists(python), source: 'bundled' },
      blender: { version: blenderVersion, executable: selected, installed: await exists(selected), source: selected === blender ? 'download' : 'system' },
      godot: { version: JSON.parse(await readFile(join(godotResources, 'lock.json'), 'utf8')).version, executable: g.executable, installed: await exists(g.executable), source: g.source },
      templates: { version: g.version, executable: g.templates, installed: g.templatesInstalled, source: 'managed' },
      packageManagers: { pnpm, npm, npmInstalled: await exists(npm) },
    }
  }
  const doctor = async kind => {
    const targets = kind === 'all' ? ['node', 'python', 'blender', 'godot'] : [kind]
    const state = await status()
    const results = {}
    for (const target of targets) {
      try {
        const entry = state[target]
        if (!entry) throw new Error(`Unknown runtime: ${target}`)
        if (!entry.installed) throw new Error('Not installed; run agent-env ensure '+target)
        let output
        if (target === 'templates') output = `Godot export templates ${entry.version}`
        else if (target === 'blender') output = entry.source === 'system' ? await checked(entry.executable, ['--version']) : await verifyBlender(entry.executable)
        else output = await checked(entry.executable, target === 'godot' ? ['--headless', '--version'] : ['--version'])
        if (target === 'node' && output !== `v${entry.version}` || target === 'python' && output !== `Python ${entry.version}` || target === 'godot' && !output.startsWith(`${entry.version}.official.`)) throw new Error('Executable differs from the pinned version')
        if (target === 'python') await checked(python, ['-I', '-B', '-m', 'venv', '--help'])
        if (target === 'node') await checked(node, [pnpm, '--version'])
        results[target] = { healthy: true, version: output.split('\n')[0], executable: entry.executable }
      } catch (error) { results[target] = { healthy: false, error: error.message } }
    }
    return results
  }
  const ensure = async (kind, repair = false) => {
    if (kind === 'all') { for (const target of ['node', 'python', 'godot', 'blender']) await ensure(target, repair); return status() }
    if (kind === 'blender') { if (repair || await selectedBlender() === blender) await install('blender', repair) }
    else if (kind === 'node') {
      const health = await doctor('node')
      if (!health.node.healthy) throw new Error(`${health.node.error}; repair bundled interpreters by reinstalling the desktop app`)
      await install('npm', repair)
    } else if (kind === 'python') {
      const health = await doctor('python')
      if (!health.python.healthy) throw new Error(`${health.python.error}; repair bundled interpreters by reinstalling the desktop app`)
    } else if (kind === 'templates') {
      await (await godot()).ensureTemplates(repair)
    } else if (kind === 'godot') {
      await (await godot()).ensureEngine(repair)
      const health = await doctor('godot')
      if (!health.godot.healthy) throw new Error(health.godot.error)
    } else throw new Error(`Unknown runtime: ${kind}`)
    return status()
  }
  const prepareProject = async (project, kinds) => {
    project = resolve(project)
    const entry = await stat(project)
    if (!entry.isDirectory()) throw new Error('Project must be an existing directory')
    return withInstallLock(join(project, '.agent-environment-lock'), async () => {
      const versions = await manifest()
      const file = join(project, '.agent-environment.json')
      const expected = { format: 1, ...(kinds.includes('node') ? { node: versions.node } : {}), ...(kinds.includes('python') ? { python: versions.python } : {}) }
      let existing = {}
      if (await exists(file)) {
        if ((await lstat(file)).isSymbolicLink()) throw new Error('Project environment metadata cannot be a filesystem link')
        existing = JSON.parse(await readFile(file, 'utf8'))
        if (existing.format !== 1) throw new Error('Unsupported project environment format')
        for (const key of ['node', 'python']) if (expected[key] && existing[key] && existing[key] !== expected[key]) throw new Error(`Project requires ${key} ${existing[key]}; this desktop ships ${expected[key]}`)
      }
      if (kinds.includes('python')) {
        await ensure('python')
        const venv = join(project, '.venv')
        const interpreter = join(venv, ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python']))
        if (await exists(venv)) {
          await regularDirectory(venv)
          if (await checked(interpreter, ['--version']) !== `Python ${versions.python}`) throw new Error('Existing .venv has a different Python; it was preserved')
        } else {
          try { await checked(python, ['-I', '-B', '-m', 'venv', venv], { timeoutMs: 120000 }) } catch (error) {
            await rm(venv, { recursive: true, force: true })
            throw error
          }
        }
      }
      if (kinds.includes('node')) await ensure('node')
      const temporary = join(project, `.agent-environment-${randomUUID()}.json`)
      try {
        await writeFile(temporary, JSON.stringify({ ...existing, ...expected }, null, 2)+'\n', { flag: 'wx', mode: 0o600 })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
      return { project, format: 1, nodeVersion: expected.node, pythonVersion: expected.python, python: kinds.includes('python') ? join(project, '.venv', ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python'])) : undefined }
    })
  }
  return { status, doctor, ensure, prepareProject, node, python, pnpm, npm,
    async launchBlender(args) { const health = await doctor('blender'); if (!health.blender.healthy) throw new Error('Blender is missing or damaged; use manage_runtime_environment ensure blender or Creation environments before execution'); return (await execute(await selectedBlender(), args)).code },
    async launchNpm(args, npx = false) {
      await ensure('node')
      return (await execute(node, [npx ? join(npmRoot, 'bin', 'npx-cli.js') : npm, ...args], {
        env: { ...process.env, npm_config_prefix: join(root, 'npm-global'), npm_config_cache: join(root, 'cache', 'npm') },
      })).code
    },
  }
}
