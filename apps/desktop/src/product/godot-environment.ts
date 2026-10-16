/** Product-owned Godot launchers inherited by Desktop Host shells and terminals. */

import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { ensureLaunchers } from '../../resources/godot/launchers.mjs'

/** Desktop resources and managed launcher locations. */
export interface GodotEnvironmentOptions {
  /** Unpacked product CLI resources, outside ASAR. */
  readonly source: string
  /** Application-owned runtime directory under the Harness home. */
  readonly root: string
  /** Bundled primary runtime carrying standalone Node and Python. */
  readonly primaryRuntime: string
  /** Target platform; defaults to the current process. */
  readonly platform?: NodeJS.Platform
}

/**
 * Create private CLI launchers without editing system PATH or shell startup files.
 * @param environment - Host environment after the macOS login-shell probe.
 * @param options - Bundled resources and application-owned installation paths.
 * @returns Host environment whose children resolve managed Godot commands first.
 */
export async function prepareGodotEnvironment(
  environment: NodeJS.ProcessEnv, options: GodotEnvironmentOptions,
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform
  // Linux build: Godot integration is not supported yet; run without managed Godot launchers.
  if (platform === 'linux') return { ...environment, GODOT_RUNTIME_ROOT: options.root, GODOT_RUNTIME_RESOURCES: options.source }
  if (!['darwin', 'win32'].includes(platform)) throw new Error(`Godot desktop integration does not support ${platform}`)
  for (const path of [options.source, options.root, options.primaryRuntime]) {
    if (!isAbsolute(path)) throw new Error('Godot runtime directories must be absolute')
  }
  const windows = platform === 'win32'
  const node = join(options.primaryRuntime, 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node')
  const python = join(options.primaryRuntime, 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']))
  const cli = join(options.source, 'cli.mjs')
  // Read required resources now so packaging omissions fail before a terminal opens.
  await Promise.all([node, python, cli, join(options.source, 'lock.json'), join(options.source, 'extract.py'), join(options.source, 'resource-worker.gd'), join(options.source, 'vollkorn-edit.gd'), join(options.source, 'VOLLKORN_LICENSE.txt')].map(path => access(path)))
  const bin = await ensureLaunchers({ root: options.root, node, python, cli, platform })
  const result = { ...environment }
  const pathKeys = Object.keys(result).filter(key => windows ? key.toUpperCase() === 'PATH' : key === 'PATH')
  const previous = pathKeys.map(key => result[key]).filter((value): value is string => value !== undefined).join(windows ? ';' : delimiter)
  for (const key of pathKeys) Reflect.deleteProperty(result, key)
  result.PATH = `${bin}${windows ? ';' : delimiter}${previous}`
  result.GODOT_RUNTIME_ROOT = options.root
  result.GODOT_RUNTIME_RESOURCES = options.source
  return result
}
