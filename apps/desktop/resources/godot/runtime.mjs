import { findExternalRuntime } from './external-runtime.mjs'
import { downloadPinned } from './download.mjs'
/** Pinned, transactional Godot installation; downloaded binaries stay outside the application bundle. */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** @param path - Required file. @returns Whether the file exists. */
export async function exists(path) {
  try { await access(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Execute without a shell, forwarding cancellation and optionally detecting Godot errors.
 * @param executable - Absolute interpreter or Godot binary.
 * @param args - Literal arguments.
 * @param options - Error detection, timeout, and silent version-probe settings.
 * @returns Exit code and bounded version-probe output.
 */
export async function execute(executable, args, { detectErrors = false, quiet = false, timeoutMs, env = process.env, onOutput, startupProjectConfig, operation = 'Godot operation' } = {}) {
  const child = spawn(executable, args, { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true, env })
  let diagnostic = false
  let probe = ''
  let interrupted = false
  let timedOut = false
  let startup = startupProjectConfig !== undefined
  let startupError = ''
  let startupOutput = ''
  let fatalConfig = false
  const tails = new Map()
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8')
    tails.set(stream, '')
    stream.on('data', chunk => {
      if (!quiet) destination.write(chunk)
      onOutput?.(chunk)
      if (startup && stream === child.stdout) {
        startupOutput = (startupOutput + chunk).slice(-1024)
        if (startupOutput.includes('Godot Engine v')) startup = false
      }
      if (startup && stream === child.stderr) {
        startupError = (startupError + chunk).slice(-8192)
        const plainStartup = startupError.replace(/\u001b\[[0-9;]*m/gu, '').replace(/\r\n/gu, '\n')
        const match = /(?:^|\n)ERROR: Error parsing '([^'\n]+)' at line \d+: [^\n]+\n\s+at: _load_settings_text \(core\/config\/project_settings\.cpp:\d+\)\nERROR: Couldn't load file '([^'\n]+)', error code 43\.\n\s+at: _load_settings_text_or_binary \(core\/config\/project_settings\.cpp:\d+\)/u.exec(plainStartup)
        if (match && match[1] === startupProjectConfig && match[2] === startupProjectConfig) {
          fatalConfig = true
          startup = false
          console.error(`${operation}: project.godot parsing failed; stopping the failed engine startup. Fix the configuration error above before retrying.`)
          stop('SIGTERM')
        }
      }
      if (quiet) probe = (probe + chunk).slice(-8192)
      const text = tails.get(stream) + chunk
      const plain = text.replace(/\u001b\[[0-9;]*m/gu, '')
      if (/(?:^|\n)\s*(?:SCRIPT ERROR:|ERROR:|Parse Error:)/u.test(plain)) diagnostic = true
      tails.set(stream, text.slice(-256))
    })
  }
  let killTimer
  const stop = signal => {
    interrupted = true
    child.kill(signal)
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 3000)
  }
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  const deadline = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    console.error(`${operation} timed out after ${timeoutMs} ms; stopping the engine.`)
    stop('SIGTERM')
  }, timeoutMs)
  try {
    const code = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (status, signal) => accept(status ?? (signal === 'SIGINT' ? 130 : signal === 'SIGKILL' ? 137 : 143)))
    })
    return { code: timedOut ? 124 : fatalConfig ? 1 : interrupted && code === 0 ? 130 : detectErrors && diagnostic && code === 0 ? 1 : code, output: probe, diagnostic }
  } finally {
    clearTimeout(deadline)
    clearTimeout(killTimer)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

export async function download(asset, directory) {
  const timeoutMs = Number(process.env.GODOT_DOWNLOAD_TIMEOUT_MS ?? 1800000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('GODOT_DOWNLOAD_TIMEOUT_MS must be a positive integer')
  return downloadPinned(asset, directory, { prefix: 'Godot', timeoutMs })
}

async function withLock(root, operation, cache = join(root, 'downloads', 'editor')) {
  await mkdir(root, { recursive: true })
  const path = join(root, 'install.lock')
  const timeout = Date.now() + 35 * 60 * 1000
  let handle
  while (handle === undefined) {
    try {
      handle = await open(path, 'wx')
      await handle.writeFile(String(process.pid))
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const recoveryPath = join(root, 'install-recovery.lock')
      let recovery
      try { recovery = await open(recoveryPath, 'wx') } catch (error) { if (error.code !== 'EEXIST') throw error }
      if (recovery !== undefined) {
        try {
          // Only one waiter can reclaim a dead owner; re-read under this separate guard
          // so a second waiter cannot delete the new installer's lock.
          const value = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
          if (/^[1-9]\d*$/u.test(value)) {
            try { process.kill(Number(value), 0) } catch (error) {
              if (error.code === 'ESRCH') await rm(path, { force: true })
              else if (error.code !== 'EPERM') throw error
            }
          } else if (await exists(path) && Date.now() - (await stat(path)).mtimeMs > 5000) {
            throw new Error(`Invalid installer lock. Remove only ${path} and retry`)
          }
        } finally { await recovery.close(); await rm(recoveryPath, { force: true }) }
      } else if (Date.now() - (await stat(recoveryPath).catch(error => { if (error.code === 'ENOENT') return { mtimeMs: Date.now() }; throw error })).mtimeMs > 5000) {
        throw new Error(`Interrupted lock recovery. Remove only ${recoveryPath} and retry`)
      }
      if (Date.now() > timeout) throw new Error(`Another Godot installer is still running. Retry after it finishes: ${path}`)
      await sleep(500)
    }
  }
  try {
    if (await exists(cache)) {
      for (const entry of await readdir(cache)) {
        if (/^[a-f0-9]{64}\.[a-f0-9-]+\.partial$/u.test(entry)) await rm(join(cache, entry), { force: true })
      }
    }
    return await operation()
  } finally {
    await handle.close()
    await rm(path, { force: true })
  }
}

/**
 * Runtime owner with target-specific editor and export-template paths.
 * @param options - Owned root, bundled Python, target and pinned release manifest.
 * @returns Installation and status operations.
 */
export function createRuntime({ root, python, platform = process.platform, arch = process.arch, home = homedir(), appData = process.env.APPDATA,
  resources = dirname(fileURLToPath(import.meta.url)), lock }) {
  if (platform !== 'darwin' && !(platform === 'win32' && arch === 'x64')) throw new Error(`Unsupported Godot desktop target: ${platform}/${arch}`)
  root = resolve(root)
  const engineRoot = join(root, 'engine')
  const executable = platform === 'darwin' ? join(engineRoot, 'Godot.app', 'Contents', 'MacOS', 'Godot')
    : join(engineRoot, 'Godot_v4.6-stable_win64_console.exe')
  // Godot's documented per-user location; keep existing same-version templates intact.
  const templates = platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Godot', 'export_templates', lock.version)
    : join(appData ?? join(home, 'AppData', 'Roaming'), 'Godot', 'export_templates', lock.version)
  const extract = async (archive, directory, isTemplates = false) => {
    const outcome = await execute(python, ['-B', join(resources, 'extract.py'), archive, directory, ...(isTemplates ? ['templates'] : [])])
    if (outcome.code !== 0) throw new Error(`Godot archive extraction failed (${outcome.code})`)
  }
  const templateReady = async (directory = templates) => {
    if (!await exists(directory)) return false
    const version = (await readFile(join(directory, 'version.txt'), 'utf8')).trim()
    if (version !== lock.version) throw new Error(`Existing export templates have an unexpected version: ${templates}`)
    // Desktop and single-threaded Web payloads must be present before reuse.
    for (const file of ['macos.zip', 'windows_release_x86_64.exe', 'windows_debug_x86_64.exe', 'web_nothreads_release.zip', 'web_nothreads_debug.zip']) {
      if (!await exists(join(directory, file)) || (await stat(join(directory, file))).size === 0) throw new Error(`Existing export templates are incomplete: ${templates}. Repair them in Godot before retrying.`)
    }
    return true
  }
  let external
  const findExternal = () => external ??= findExternalRuntime('godot', lock.version, { platform, home, excludedRoots: [root] })
  const ensureEngine = async (repair = false) => {
    if (!repair) { const found = await findExternal(); if (found) return found }
    if (!repair && await exists(join(engineRoot, 'installed.json'))) {
      if (!await exists(executable)) throw new Error(`Godot installation is incomplete: ${engineRoot}`)
      return executable
    }
    return withLock(root, async () => {
      if (!repair && await exists(join(engineRoot, 'installed.json')) && await exists(executable)) return executable
      if (!repair && await exists(engineRoot)) throw new Error(`Unfinished Godot installation at ${engineRoot}; move it aside before retrying`)
      const archive = await download(lock.assets[platform], join(root, 'downloads', 'editor'))
      const staging = await mkdtemp(join(root, 'engine-staging-'))
      try {
        console.error(`Godot: extracting engine ${lock.version}.`)
        await extract(archive, staging)
        console.error(`Godot: checking engine version ${lock.version}.`)
        const relativeExecutable = executable.slice(engineRoot.length + 1)
        const version = await execute(join(staging, relativeExecutable), ['--headless', '--version'], { quiet: true, timeoutMs: 30000 })
        if (version.code !== 0 || !version.output.trim().startsWith(`${lock.version}.official.`)) throw new Error('Downloaded Godot executable does not match the pinned version')
        const manifest = await open(join(staging, 'installed.json'), 'wx')
        try { await manifest.writeFile(JSON.stringify({ version: lock.version, sha256: lock.assets[platform].sha256 })) } finally { await manifest.close() }
        const previous = `${engineRoot}.previous-${randomUUID()}`
        const replacing = await exists(engineRoot)
        if (replacing) await rename(engineRoot, previous)
        try { await rename(staging, engineRoot) } catch (error) {
          if (replacing) await rename(previous, engineRoot)
          throw error
        }
        if (replacing) console.error(`Godot: retained previous engine at ${previous}`)
        console.error(`Godot: ${lock.version} is ready.`)
        return executable
      } finally { await rm(staging, { recursive: true, force: true }) }
    })
  }
  const ensureTemplates = async (repair = false) => {
    if (!repair && await templateReady()) return templates
    return withLock(join(dirname(templates), `.opengame-${lock.version}-install`), async () => {
      if (!repair && await templateReady()) return templates
      const archive = await download(lock.assets.templates, join(root, 'downloads', 'templates'))
      await mkdir(dirname(templates), { recursive: true })
      const staging = await mkdtemp(join(dirname(templates), '.godot-staging-'))
      try {
        console.error(`Godot: extracting export templates ${lock.version}.`)
        await extract(archive, staging, true)
        if ((await readFile(join(staging, 'version.txt'), 'utf8')).trim() !== lock.version) throw new Error('Export templates do not match Godot 4.6')
        await templateReady(staging)
        const replacing = await exists(templates)
        if (replacing && !repair) {
          await templateReady()
          return templates
        }
        const previous = `${templates}.previous-${randomUUID()}`
        if (replacing) await rename(templates, previous)
        try { await rename(staging, templates) } catch (error) {
          if (replacing) await rename(previous, templates)
          throw error
        }
        if (replacing) console.error(`Godot: retained previous templates at ${previous}`)
        console.error(`Godot: export templates ${lock.version} are ready.`)
        return templates
      } finally { await rm(staging, { recursive: true, force: true }) }
    }, join(root, 'downloads', 'templates'))
  }
  return {
    executable, templates, ensureEngine, ensureTemplates,
    async requireEngine() {
      const found = await findExternal(); if (found) return found
      if (!await exists(executable)) throw new Error('Godot is missing; use manage_runtime_environment ensure godot or load_godot_runtime before execution')
      const version = await execute(executable, ['--headless', '--version'], { quiet: true, timeoutMs: 5000 })
      if (version.code !== 0 || !version.output.trim().startsWith(`${lock.version}.official.`)) throw new Error('Godot is damaged or incompatible; repair it in Creation environments')
      return executable
    },
    async status() { const found = await findExternal(); return { version: lock.version, executable: found ?? executable, source: found ? 'system' : 'managed', engineInstalled: Boolean(found) || await exists(join(engineRoot, 'installed.json')) && await exists(executable),
      templates, templatesInstalled: await templateReady().catch(() => false), templatesNeedRepair: await exists(templates) && !await templateReady().catch(() => false) } },
  }
}
