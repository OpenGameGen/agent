/** Product-owned identity shared by packaging, Electron and the installed CLI. */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const PRODUCT = Object.freeze({ name: 'OpenGameGen', appId: 'com.opengamegen.desktop', scheme: 'opengamegen', command: 'opengamegen', artifact: 'opengamegen' })

/** Fail closed when a stale release file still selects the official application identity. */
export function productAppId(env = process.env) {
  if (env.DSH_DESKTOP_APP_ID && env.DSH_DESKTOP_APP_ID !== PRODUCT.appId) {
    throw new Error(`OpenGameGen packaging requires DSH_DESKTOP_APP_ID=${PRODUCT.appId}; update the platform release configuration`)
  }
  return PRODUCT.appId
}

function canonical(path) {
  try { return realpathSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(canonical(parent), relative(parent, path))
  }
}
function overlaps(left, right) {
  const contains = (a, b) => { const tail = relative(a, b); return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail)) }
  return contains(left, right) || contains(right, left)
}
function productRoot(value, fallback, home) {
  const path = value?.trim() || fallback
  if (!isAbsolute(path)) throw new Error('OpenGameGen data overrides must be absolute paths')
  const selected = canonical(resolve(path))
  for (const protectedPath of [join(home, '.dsh'), join(home, '.agents')]) {
    if (overlaps(selected, canonical(protectedPath))) throw new Error('OpenGameGen data must be separate from the official Harness and shared agent roots')
  }
  return selected
}

/** Ignore ambient official DSH paths; opt-in product overrides are explicit and checked. */
export function productEnvironment(env = process.env, home = homedir()) {
  const root = productRoot(env.OPENGAMEGEN_HOME, join(home, '.opengamegen'), home)
  return { ...env, DSH_HOME: root, DSH_AGENTS_HOME: productRoot(undefined, join(root, 'agents'), home) }
}

/** Electron must select these paths before logs, sessions and its single-instance lock. */
export function initializeProductApp(app, env = process.env) {
  const selected = productEnvironment(env)
  const userData = productRoot(env.OPENGAMEGEN_USER_DATA, join(app.getPath('appData'), PRODUCT.name), homedir())
  if (overlaps(userData, canonical(selected.DSH_HOME))) throw new Error('OpenGameGen Electron data and retained Harness data must have separate roots')
  for (const name of ['DeepSeek Harness', '@deepseek-ai/dsh-desktop']) {
    if (overlaps(userData, canonical(join(app.getPath('appData'), name)))) throw new Error('OpenGameGen Electron data must be separate from official Electron data')
  }
  app.setName(PRODUCT.name)
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  app.setPath('crashDumps', join(userData, 'Crashpad'))
  app.setAppLogsPath(process.platform === 'darwin' ? resolve(app.getPath('appData'), '..', 'Logs', PRODUCT.name) : join(userData, 'logs'))
  Object.assign(env, selected)
}

/** One product-owned location for installer and application dependencies, independent of profile selection. */
export function productRuntimePaths(env = process.env, home = homedir()) {
  const root = productEnvironment(env, home).DSH_HOME
  return { home: root, environments: join(root, 'dsh-runtimes', 'environments'), godot: join(root, 'dsh-runtimes', 'godot-4.6') }
}
