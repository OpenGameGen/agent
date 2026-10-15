/** Shared managed command generation for desktop startup and explicit runtime repair. */
import { access, stat, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'` }
function cmdQuote(value) {
  if (/["\r\n]/u.test(value)) throw new Error('Godot launcher path contains unsupported characters')
  return `"${value.replaceAll('%', '%%')}"`
}
/** Write and verify launchers using explicit, already selected runtime interpreters. */
export async function ensureLaunchers({ root, node, python, cli, platform = process.platform }) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error(`Godot desktop integration does not support ${platform}`)
  for (const path of [root, node, python, cli]) {
    if (!isAbsolute(path)) throw new Error('Godot launcher paths must be absolute')
  }
  const windows = platform === 'win32'
  await Promise.all([node, python, cli].map(async path => {
    if (!(await stat(path)).isFile()) throw new Error(`Godot launcher dependency is not a regular file: ${path}`)
    await access(path, path === cli ? constants.R_OK : windows ? constants.F_OK : constants.X_OK)
  }))
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  for (const command of ['godot', 'godot4', 'godot-project']) {
    const args = [node, '--use-env-proxy', cli, '--runtime', root, '--python', python, '--mode', command === 'godot-project' ? 'project' : 'engine']
    const scripts = [[command, `#!/bin/sh\nexec ${args.map(shellQuote).join(' ')} "$@"\n`, 0o755]]
    if (windows) scripts.push([`${command}.cmd`, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${args.map(cmdQuote).join(' ')} %*\r\nexit /b %errorlevel%\r\n`, 0o644])
    for (const [name, contents, mode] of scripts) {
      const target = join(bin, name), temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, contents, { mode, flag: 'wx' })
        await rename(temporary, target)
        await access(target, windows ? constants.F_OK : constants.X_OK)
      } finally { await rm(temporary, { force: true }) }
    }
  }
  return bin
}
