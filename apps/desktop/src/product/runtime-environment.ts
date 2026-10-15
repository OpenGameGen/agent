/** Product environment launchers scoped to Desktop Host children. */
import { access, mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Trusted resource and installation directories selected by the desktop shell. */
export interface RuntimeEnvironmentOptions {
  readonly source: string
  readonly root: string
  readonly primaryRuntime: string
  readonly platform?: NodeJS.Platform
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function cmdQuote(value: string): string {
  if (/["\r\n]/u.test(value)) throw new Error('Environment launcher path contains unsupported characters')
  return `"${value.replaceAll('%', '%%')}"`
}

/**
 * Publish managed commands without changing system PATH or shell configuration.
 * @param environment - Host environment including existing Godot launchers.
 * @param options - Product resources and bundled interpreters.
 * @returns Environment inherited by local shell and terminal processes.
 */
export async function prepareRuntimeEnvironment(
  environment: NodeJS.ProcessEnv, options: RuntimeEnvironmentOptions,
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform
  if (!['darwin', 'win32'].includes(platform)) throw new Error(`Unsupported desktop environment: ${platform}`)
  for (const path of [options.source, options.root, options.primaryRuntime]) if (!isAbsolute(path)) throw new Error('Environment paths must be absolute')
  const godotRoot = environment.GODOT_RUNTIME_ROOT
  const godotResources = environment.GODOT_RUNTIME_RESOURCES
  if (!godotRoot || !godotResources || !isAbsolute(godotRoot) || !isAbsolute(godotResources)) throw new Error('Prepare Godot environment before shared runtime launchers')
  const windows = platform === 'win32'
  const nodeBin = join(options.primaryRuntime, 'dependencies', 'node', 'bin')
  const node = join(nodeBin, windows ? 'node.exe' : 'node')
  const pythonBin = join(options.primaryRuntime, 'dependencies', 'python', ...(windows ? [] : ['bin']))
  await Promise.all([node, join(pythonBin, windows ? 'python.exe' : 'python3'), join(options.source, 'cli.mjs'), join(options.source, 'runtime.mjs'), join(options.source, 'setup.mjs'),
    join(options.source, 'lock.json'), join(options.source, 'extract.py'), join(options.source, 'desktop.patch.yml'), join(options.source, 'free-models.json'), join(options.primaryRuntime, 'runtime.json')].map(path => access(path)))
  const bin = join(options.root, 'bin')
  await mkdir(bin, { recursive: true })
  const config = join(options.root, 'launcher.json')
  await writeFileAtomic(config, JSON.stringify({
    root: options.root, primaryRuntime: options.primaryRuntime, godotRoot, godotResources, resources: options.source,
  }), { mode: 0o600 })
  for (const [command, mode] of Object.entries({ 'agent-env': 'env', blender: 'blender', npm: 'npm', npx: 'npx', pnpm: 'pnpm', python: 'python', python3: 'python', pip: 'pip', pip3: 'pip' })) {
    const args = [node, '--use-env-proxy', join(options.source, 'cli.mjs'), '--config', config, '--mode', mode]
    await writeFileAtomic(join(bin, command), `#!/bin/sh\nexec ${args.map(shellQuote).join(' ')} "$@"\n`, { mode: 0o755 })
    if (windows) await writeFileAtomic(join(bin, `${command}.cmd`), `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${args.map(cmdQuote).join(' ')} %*\r\nexit /b %errorlevel%\r\n`, { mode: 0o644 })
  }
  const result = { ...environment }
  const keys = Object.keys(result).filter(key => windows ? key.toUpperCase() === 'PATH' : key === 'PATH')
  const separator = windows ? ';' : ':'
  const previous = keys.map(key => result[key]).filter(value => value !== undefined).join(separator)
  for (const key of keys) Reflect.deleteProperty(result, key)
  result.PATH = [bin, nodeBin, pythonBin, previous].join(separator)
  result.AGENT_ENV_CONFIG = config
  result.AGENT_ENV_RESOURCES = options.source
  result.PIP_REQUIRE_VIRTUALENV = 'true'
  result.PIP_CACHE_DIR = join(options.root, 'cache', 'pip')
  result.npm_config_cache = join(options.root, 'cache', 'npm')
  result.PYTHONNOUSERSITE = '1'
  result.PYTHONDONTWRITEBYTECODE = '1'
  return result
}
