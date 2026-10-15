/** Transactional application installation followed by creation dependencies; never boots Harness. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const execute = promisify(execFile)
const progress = stage => console.log(`Installer-stage: ${JSON.stringify(stage)}`)

async function signature(application) {
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
  const { stderr } = await execute('/usr/bin/codesign', ['-d', '--verbose=4', application])
  const digest = /^CDHash=(\w+)$/mu.exec(stderr)?.[1]
  if (!digest) throw new Error('Application signature digest is missing')
  return digest
}
async function ownedApplication(application) {
  const stat = await lstat(application)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Installation destination must be an application directory, not a link')
  const { stdout } = await execute('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(application, 'Contents/Info.plist')])
  if (stdout.trim() !== 'com.opengamegen.desktop') throw new Error('A different application already occupies the installation destination')
}

/**
 * Install the sealed application and reuse the same product data across reinstalls.
 * @param options - Installer-owned payload, destination and signature manifest.
 * @returns Installed application and dependency outcomes, after all checks succeed.
 */
export async function installProduct({ payload, destination, manifest }) {
  if (process.platform !== 'darwin' || ![payload, destination, manifest].every(isAbsolute) || !destination.endsWith('/OpenGameGen.app')) throw new Error('Invalid macOS installation locations')
  const expected = JSON.parse(await readFile(manifest, 'utf8'))
  await ownedApplication(payload)
  if (await signature(payload) !== expected.cdhash) throw new Error('Installer payload signature does not match its manifest')
  const { stdout: commands } = await execute('/bin/ps', ['-axo', 'command='])
  if (commands.split('\n').some(command => command.trimStart().startsWith(`${destination}/Contents/`))) throw new Error('OpenGameGen is running. Quit it before installing again.')
  let present = false
  try { await ownedApplication(destination); present = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  let reused = false
  if (present) {
    try { reused = await signature(destination) === expected.cdhash } catch (error) {
      // The bundle identifier was checked; a damaged product can be replaced transactionally.
      console.error(`Installer: replacing damaged product (${error.code ?? 'signature check failed'})`)
    }
  }
  if (!reused && resolve(payload) === resolve(destination)) throw new Error('Cannot install over the installer payload')
  progress({ target: 'application', phase: reused ? 'reusing' : 'installing' })
  if (!reused) {
    await mkdir(dirname(destination), { recursive: true })
    const staging = await mkdtemp(join(dirname(destination), '.opengamegen-stage-'))
    const staged = join(staging, 'OpenGameGen.app')
    try {
      await execute('/usr/bin/ditto', [payload, staged], { maxBuffer: 1024 * 1024 })
      if (await signature(staged) !== expected.cdhash) throw new Error('Staged application signature differs from payload')
      const previous = `${destination}.previous-${randomUUID()}`
      if (present) await rename(destination, previous)
      try { await rename(staged, destination) } catch (error) {
        if (present) await rename(previous, destination)
        throw error
      }
      if (present) console.error('Installer: previous application retained')
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  progress({ target: 'application', phase: 'ready', reused })
  const runtime = join(destination, 'Contents/Resources/runtime')
  const { installCreationRuntime } = await import(pathToFileURL(join(runtime, 'product/install-runtime.mjs')).href)
  const dependencies = await installCreationRuntime(runtime, progress)
  console.log('Installer: installation complete')
  return { application: destination, reused, dependencies }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 6 || args[0] !== '--payload' || args[2] !== '--destination' || args[4] !== '--manifest') throw new Error('Use the standalone installer')
  installProduct({ payload: args[1], destination: args[3], manifest: args[5] })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
