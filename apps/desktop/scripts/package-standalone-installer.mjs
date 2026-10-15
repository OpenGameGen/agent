/** Build a native macOS installer from an already verified desktop payload. */
import { notarizeMacOS } from './notarize-macos.mjs'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { parseArgs, promisify } from 'node:util'
const desktop = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { arch: { type: 'string', default: process.arch }, payload: { type: 'string' }, output: { type: 'string' }, online: { type: 'boolean', default: false }, 'release-url': { type: 'string' }, 'signing-identity': { type: 'string' }, 'notary-profile': { type: 'string' }, 'notary-keychain': { type: 'string' } } })
if (process.platform !== 'darwin' || !['arm64','x64'].includes(values.arch)) throw new Error('Native installer builds require macOS arm64 or x64')
const signing = values['signing-identity']
if (Boolean(signing) !== Boolean(values['notary-profile'])) throw new Error('Signed installers require both Developer ID identity and notarization profile')
if (signing && !signing.startsWith('Developer ID Application:')) throw new Error('Use a Developer ID Application installer identity')
const paths = desktopTargetBuildPaths(`mac-${values.arch}`)
const payload = resolve(values.payload ?? join(paths.unsignedArtifacts, values.arch === 'arm64' ? 'mac-arm64' : 'mac', 'OpenGameGen.app'))
const output = resolve(values.output ?? join(paths.root, 'standalone-installer', new Date().toISOString().replaceAll(':','-')))
if (existsSync(output)) throw new Error(`Choose a fresh installer output directory: ${output}`)
execFileSync('/usr/bin/codesign', ['--verify','--deep','--strict',payload])
if (!existsSync(join(payload,'Contents/Resources/runtime/product/install-runtime.mjs'))) throw new Error('Desktop payload lacks installation runtime resources; prepare and package it first')
const image = join(output,'image')
const installer = join(image,'OpenGameGen Installer.app')
const resources = join(installer,'Contents/Resources')
mkdirSync(join(installer,'Contents/MacOS'),{recursive:true})
mkdirSync(resources,{recursive:true})
let archive
if (values.online) {
  const release = new URL(values['release-url'])
  if (release.origin !== 'https://github.com' || !/^\/OpenGameGen\/agent\/releases\/download\/[^/]+\/$/u.test(release.pathname) || release.search || release.hash || release.username || release.password) throw new Error('Explicit immutable OpenGameGen/agent release URL is required')
  const name = `opengamegen-desktop-mac-${values.arch}.zip`
  const path = join(output, name)
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', payload, path])
  const bytes = readFileSync(path)
  const url = new URL(name, release).href
  archive = { name, url, mirrors: ['https://gh-proxy.com/' + url, 'https://ghfast.top/' + url], size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  cpSync(join(payload,'Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node'),join(resources,'bootstrap-node'))
  cpSync(join(payload,'Contents/Resources/runtime/primary-runtime/dependencies/node/LICENSE'),join(resources,'NODE_LICENSE.txt'))
  cpSync(join(desktop,'resources/godot/download.mjs'),join(resources,'download.mjs'))
  cpSync(join(desktop,'resources/product/identity.mjs'),join(resources,'identity.mjs'))
  cpSync(join(desktop,'installer/macos/install-online.mjs'),join(resources,'install-online.mjs'))
} else execFileSync('/usr/bin/ditto',[payload,join(resources,'desktop.app')])
cpSync(join(desktop,'installer/macos/install.mjs'),join(resources,'install.mjs'))
const { stderr: result } = await promisify(execFile)('/usr/bin/codesign',['-d','--verbose=4',payload])
const cdhash=/^CDHash=(\w+)$/mu.exec(result)?.[1]
if (!cdhash) throw new Error('Payload CodeDirectory hash is missing')
writeFileSync(join(resources,'install-manifest.json'),JSON.stringify({archive,cdhash,arch:values.arch,version:JSON.parse(readFileSync(join(desktop,'package.json'),'utf8')).version}))
writeFileSync(join(installer,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.opengamegen.installer</string><key>CFBundleName</key><string>OpenGameGen Installer</string><key>CFBundleExecutable</key><string>OpenGameGenInstaller</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`)
execFileSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-target',`${values.arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx13.0`,join(desktop,'installer/macos/main.swift'),'-o',join(installer,'Contents/MacOS/OpenGameGenInstaller')])
execFileSync('/usr/bin/codesign',['--force','--sign',signing ?? '-', ...(signing ? ['--timestamp','--options','runtime'] : []), installer])
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',installer])
if (signing) await notarizeMacOS({ appPath: installer, keychainProfile: values['notary-profile'], ...(values['notary-keychain'] ? { keychain: values['notary-keychain'] } : {}) })
const dmg=join(output,`opengamegen-installer-mac-${values.arch}.dmg`)
execFileSync('/usr/bin/hdiutil',['create','-fs','HFS+','-format','UDZO','-volname','OpenGameGen Installer','-srcfolder',image,dmg],{stdio:'inherit'})
if (signing) {
  execFileSync('/usr/bin/codesign', ['--force','--sign',signing,'--timestamp',dmg])
  await notarizeMacOS({ appPath: dmg, keychainProfile: values['notary-profile'], ...(values['notary-keychain'] ? { keychain: values['notary-keychain'] } : {}) })
}
console.log(dmg)
