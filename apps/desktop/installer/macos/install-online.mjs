import { realpathSync } from 'node:fs'
/** Product-owned online bootstrap. The immutable release asset is pinned in the sealed installer. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadPinned } from './download.mjs'
import { productEnvironment } from './identity.mjs'
import { installProduct } from './install.mjs'
const execute = promisify(execFile)
export async function installOnline({ resources, destination }) {
  const manifest = join(resources, 'install-manifest.json')
  const expected = JSON.parse(await readFile(manifest, 'utf8'))
  // Reuse only a signed exact-release bundle; installProduct checks identity, running state and dependencies.
  try {
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination])
    const { stderr } = await execute('/usr/bin/codesign', ['-d', '--verbose=4', destination])
    if (/^CDHash=(\w+)$/mu.exec(stderr)?.[1] === expected.cdhash) return installProduct({ payload: destination, destination, manifest })
  } catch { /* A missing or damaged target needs a verified payload. */ }
  const cache = join(productEnvironment().DSH_HOME, 'installer', 'downloads')
  console.log('Installer-stage: {"target":"application","phase":"installing"}')
  const archive = await downloadPinned(expected.archive, cache, { prefix: 'Installer' })
  await mkdir(cache, { recursive: true })
  const staging = await mkdtemp(join(cache, 'application-'))
  try {
    await execute('/usr/bin/ditto', ['-x', '-k', archive, staging])
    return await installProduct({ payload: join(staging, 'OpenGameGen.app'), destination, manifest })
  } finally { await rm(staging, { recursive: true, force: true }) }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--destination') throw new Error('Use the online installer')
  installOnline({ resources: fileURLToPath(new URL('.', import.meta.url)), destination: resolve(args[1]) })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
