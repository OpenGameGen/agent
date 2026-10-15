/** Pure release metadata generation; published artifacts must separately pass native signing checks. */
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { valid, gt } from 'semver'
export async function createProductUpdateFeed({ archive, version, target, tag, previousVersion }) {
  if (!valid(version) || version.includes('+')) throw new Error('An ordered semantic application version is required')
  if (previousVersion !== undefined && (!valid(previousVersion) || !gt(version, previousVersion))) throw new Error('Update version must be newer than the previous release')
  if (!['mac-arm64', 'mac-x64', 'win-x64'].includes(target) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(tag)) throw new Error('Invalid release target or tag')
  const name = basename(archive)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name) || !name.startsWith('opengamegen-') || !name.endsWith(target.startsWith('mac-') ? '.zip' : '.exe')) throw new Error('Update requires a product application ZIP or signed Windows installer, never the online bootstrap')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const url = `https://github.com/OpenGameGen/agent/releases/download/${tag}/${name}`
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  return { filename: `nightly-${arch}${target.startsWith('mac-') ? '-mac' : ''}.yml`,
    info: { version, files: [{ url, sha512, size: (await stat(archive)).size }], path: url, sha512, releaseDate: new Date().toISOString() } }
}
