/** Keep Godot's writable per-user files inside its project, without relaxing the process sandbox. */
import { mkdir, realpath, symlink } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute, resolve, sep } from 'node:path'
import { exists } from './runtime.mjs'

/** @param project - Canonical project directory. @param templates - Trusted runtime-owned template directory. @returns Child-only environment. */
export async function projectEnvironment(project, templates, platform = process.platform) {
  const home = join(project, '.godot', 'opengame-user')
  const appData = join(home, 'AppData', 'Roaming')
  const localData = join(home, 'AppData', 'Local')
  const config = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'win32' ? appData : join(home, '.config')
  const data = platform === 'linux' ? join(home, '.local', 'share') : config
  const cache = platform === 'darwin' ? join(home, 'Library', 'Caches') : platform === 'win32' ? localData : join(home, '.cache')
  for (const path of new Set([config, data, cache])) await projectDirectory(project, path)
  if (templates && await exists(templates)) {
    const target = join(data, 'Godot', 'export_templates', basename(templates))
    await projectDirectory(project, dirname(target))
    if (await exists(target)) {
      if (await realpath(target) !== await realpath(templates)) throw new Error('Godot isolated template directory conflicts with the managed templates')
    } else {
      try { await symlink(templates, target, platform === 'win32' ? 'junction' : 'dir') }
      catch (error) { if (error.code !== 'EEXIST' || await realpath(target) !== await realpath(templates)) throw error }
    }
  }
  return { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localData,
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache }
}

/** Create each managed directory only after verifying its existing ancestors stay project-local. */
async function projectDirectory(project, directory) {
  let path = project
  for (const part of relative(project, directory).split(sep)) {
    path = join(path, part)
    try { await mkdir(path) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const remainder = relative(project, await realpath(path))
    if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw new Error('Godot user directory must stay inside the project')
  }
}

/** Resolve standard Godot argv without creating user directories for information-only commands. */
export async function engineEnvironment(args, templates, cwd = process.cwd()) {
  const separator = args.findIndex(arg => arg === '--' || arg === '++')
  const engineArgs = args.slice(0, separator < 0 ? undefined : separator)
  if (engineArgs.some(arg => ['--version', '--help', '-h'].includes(arg))) return process.env
  const pathIndex = engineArgs.indexOf('--path')
  const projectFile = engineArgs.find(arg => basename(arg) === 'project.godot')
  const directory = pathIndex >= 0 ? engineArgs[pathIndex + 1] : projectFile ? dirname(projectFile) : cwd
  const project = directory && resolve(cwd, directory)
  return project && await exists(join(project, 'project.godot'))
    ? projectEnvironment(await realpath(project), templates) : process.env
}
