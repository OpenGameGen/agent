/** Prepare creation tools during installation without launching the desktop profile. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productRuntimePaths } from './identity.mjs'
import { prepareCreationEnvironment } from '../environments/setup.mjs'

/**
 * Use the same product home and fixed runtime locations as Desktop.
 * @param resources - Installed application's runtime resource directory.
 * @param notify - Installer-owned progress receiver.
 * @returns Verified dependency results, without creating a Host or session.
 */
export async function installCreationRuntime(resources, notify) {
  if (!isAbsolute(resources)) throw new Error('Installed runtime resources must be absolute')
  process.env.PYTHONDONTWRITEBYTECODE = '1'
  const paths = productRuntimePaths()
  const root = paths.environments
  const config = { root, primaryRuntime: join(resources, 'primary-runtime'), resources: join(resources, 'environments'),
    godotRoot: paths.godot, godotResources: join(resources, 'godot') }
  // Read the installed metadata before making an installation directory.
  const manifest = JSON.parse(await readFile(join(config.primaryRuntime, 'runtime.json'), 'utf8'))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Installed application architecture does not match this installer')
  await mkdir(root, { recursive: true })
  const file = join(root, 'launcher.json')
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
  await rename(temporary, file)
  return prepareCreationEnvironment(config, notify)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--resources' || !isAbsolute(process.argv[3])) throw new Error('Use the product installer')
  installCreationRuntime(process.argv[3], stage => console.log(`Installer-stage: ${JSON.stringify(stage)}`))
    .then(() => console.log('Installer: creation environment ready'))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
