import { PRODUCT } from '../resources/product/identity.mjs'
/** Package terminal launch scripts that reuse the installed Electron runtime. */

import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Copy the platform launcher into the application's public command directory.
 * @param destination - Physical runtime/cli directory prepared for the application.
 * @param platform - Target Desktop operating system.
 */
export function prepareDesktopCli(destination: string, platform: 'darwin' | 'win32'): void {
  const source = platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const name = platform === 'win32' ? `${PRODUCT.command}.cmd` : PRODUCT.command
  const command = join(destination, 'bin', name)
  mkdirSync(join(destination, 'bin'), { recursive: true })
  for (const legacy of ['dsh', 'dsh.cmd']) rmSync(join(destination, 'bin', legacy), { force: true })
  copyFileSync(join(import.meta.dirname, '..', 'cli', source), command)
  for (const file of ['identity.mjs', 'cli.mjs']) copyFileSync(join(import.meta.dirname, '..', 'resources', 'product', file), join(destination, file))
  if (platform === 'darwin') chmodSync(command, 0o755)
}
