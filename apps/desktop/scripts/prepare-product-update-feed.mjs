/** Signed release publication gate. This command creates metadata, never publishes credentials or files. */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { load, dump } from 'js-yaml'
import { createProductUpdateFeed } from './product-update-feed.mjs'
const { values } = parseArgs({ options: { archive: { type: 'string' }, target: { type: 'string' }, tag: { type: 'string' }, version: { type: 'string' }, output: { type: 'string' }, 'previous-version': { type: 'string' } } })
if (!values.archive || !values.target || !values.tag || !values.version || !values.output) throw new Error('Provide --archive --target --tag --version --output')
const archive = resolve(values.archive)
if (values.target.startsWith('mac-')) {
  if (process.platform !== 'darwin') throw new Error('Verify macOS update signatures on macOS')
  const staging = await mkdtemp(join(tmpdir(), 'opengamegen-update-signature-'))
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, staging])
    const app = join(staging, 'OpenGameGen.app')
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    const { spawnSync } = await import('node:child_process')
    const signature = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8' })
    if (!/^Authority=Developer ID Application:/mu.test(signature.stderr)) throw new Error('A Developer ID Application signature is required; ad-hoc/development updates cannot be published')
    execFileSync('/usr/bin/xcrun', ['stapler', 'validate', app])
    const field = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
    if (field('CFBundleIdentifier') !== 'com.opengamegen.desktop' || field('CFBundleShortVersionString') !== values.version) throw new Error('Update app identity or installed version differs from metadata')
    const runtime = JSON.parse(await readFile(join(app, 'Contents/Resources/runtime/primary-runtime/runtime.json'), 'utf8'))
    if (runtime.platform !== 'darwin' || runtime.arch !== values.target.slice(4)) throw new Error('Update application architecture differs from target channel')
    const feed = load(await readFile(join(app, 'Contents/Resources/app-update.yml'), 'utf8'))
    if (feed?.provider !== 'generic' || feed.url !== 'https://github.com/OpenGameGen/agent/releases/latest/download/') throw new Error('Update application must retain its product GitHub update source')
  } finally { await rm(staging, { recursive: true, force: true }) }
} else {
  if (values.target !== 'win-x64' || process.platform !== 'win32') throw new Error('Verify Windows Authenticode on Windows')
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $args[0];if($s.Status -ne 'Valid'){throw 'Valid Authenticode signature required'};$v=(Get-Item -LiteralPath $args[0]).VersionInfo;if($v.ProductName -ne 'OpenGameGen' -or $v.ProductVersion -ne $args[1]){throw 'Update product/version mismatch'}"
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script, archive, values.version], { windowsHide: true })
}
const result = await createProductUpdateFeed({ archive, target: values.target, tag: values.tag, version: values.version, previousVersion: values['previous-version'] })
await mkdir(resolve(values.output), { recursive: true })
await writeFile(join(resolve(values.output), result.filename), dump(result.info, { lineWidth: -1 }))
console.log(result.filename)
