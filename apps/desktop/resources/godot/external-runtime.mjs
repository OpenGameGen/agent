/** Discover locally installed, release-compatible tools without downloading or changing them. */
import { execFile } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Version probing is bounded and never uses a shell or user-defined arguments. */
export async function findExternalRuntime(kind, version, { platform = process.platform, home = homedir(), env = process.env,
  candidates, excludedRoots = [], probe = async (file, args) => (await run(file, args, { timeout: 5000, maxBuffer: 32768, windowsHide: true })).stdout } = {}) {
  const names = kind === 'godot' ? (platform === 'win32' ? ['godot.exe', 'godot4.exe', 'Godot_v4.6-stable_win64_console.exe'] : ['godot', 'godot4'])
    : platform === 'win32' ? ['blender.exe'] : ['blender']
  const paths = candidates ?? []
  if (!candidates) {
    const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    for (const directory of searchPath.split(platform === 'win32' ? ';' : delimiter)) {
      if (isAbsolute(directory)) for (const name of names) paths.push(join(directory, name))
    }
    if (platform === 'darwin') {
      for (const directory of ['/Applications', join(home, 'Applications')]) paths.push(kind === 'godot'
        ? join(directory, 'Godot.app', 'Contents', 'MacOS', 'Godot') : join(directory, 'Blender.app', 'Contents', 'MacOS', 'Blender'))
    } else if (platform === 'win32') {
      for (const directory of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined].filter(Boolean)) {
        const base = kind === 'blender' ? join(directory, 'Blender Foundation') : join(directory, 'Godot')
        const children = await readdir(base, { withFileTypes: true }).catch(() => [])
        for (const child of children.slice(0, 32)) if (child.isDirectory()) for (const name of names) paths.push(join(base, child.name, name))
        for (const name of names) paths.push(join(base, name))
      }
    }
  }
  if (env.AGENT_ENV_CONFIG) excludedRoots = [...excludedRoots, dirname(env.AGENT_ENV_CONFIG)]
  if (env.GODOT_RUNTIME_ROOT) excludedRoots = [...excludedRoots, env.GODOT_RUNTIME_ROOT]
  for (const file of [...new Set(paths)].slice(0, 64)) {
    // Product launchers would recurse into this detector. External installations stay read-only.
    if (!isAbsolute(file) || /[/\\]dsh-runtimes[/\\]/iu.test(resolve(file)) || excludedRoots.some(root => { const path = relative(root, file); return path === '' || !path.startsWith('..') && !isAbsolute(path) })) continue
    try {
      await access(file)
      const output = (await probe(file, kind === 'godot' ? ['--headless', '--version'] : ['--version'])).trim()
      const blenderVersion = /^Blender (\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output)
      const compatible = kind === 'godot' ? output.startsWith(`${version}.official.`)
        : Boolean(blenderVersion && (Number(blenderVersion[1]) === 4 && Number(blenderVersion[2]) >= 5 || Number(blenderVersion[1]) === 5))
      if (compatible) return file
    } catch { /* Missing, broken, incompatible or timed-out installations cannot be reused. */ }
  }
  return undefined
}
