/** Product-owned publication policy; upstream feed resolvers retain their original behavior. */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDesktopAutoUpdateEnvironment, resolveDesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { verifyMacOSAppUpdateConfig } from './macos-app-update-config.mjs'

/** @param {NodeJS.ProcessEnv} env Release configuration. @returns {boolean} Explicit update opt-in. */
export function productUpdatesEnabled(env) {
  const mode = env.OPENGAME_UPDATE_MODE?.trim() || 'disabled'
  if (!['disabled', 'enabled'].includes(mode)) throw new Error('product release: OPENGAME_UPDATE_MODE must be disabled or enabled')
  return mode === 'enabled' && env.DSH_DESKTOP_UNSIGNED !== '1'
}
function ownOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('product release: explicitly configure a private HTTPS update origin') }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || host === 'deepseek.com' || host.endsWith('.deepseek.com')) throw new Error('product release: update origin must be owned HTTPS, never the official DeepSeek domain')
  return url.origin
}
/** @param {NodeJS.ProcessEnv} env Release configuration. @param {NodeJS.Platform} platform Target. @param {string} arch Architecture. @returns {import('./desktop-auto-update-environment.mjs').DesktopAutoUpdateConfig | undefined} Optional feed. */
export function resolveProductUpdateConfig(env, platform, arch) {
  if (!productUpdatesEnabled(env)) return undefined
  if (env.OPENGAME_UPDATE_PROVIDER === 'github') {
    if (resolveDesktopAutoUpdateEnvironment(env) !== 'production') throw new Error('product release: GitHub latest updates require explicit production deployment')
    const target = resolveDesktopAutoUpdateTarget(platform, arch)
    return { environment: resolveDesktopAutoUpdateEnvironment(env), target, origin: 'https://github.com', keyPrefix: '', binaryKeyPrefix: '',
      publicUrl: 'https://github.com/OpenGameGen/agent/releases/latest/download/' }
  }
  if (env.OPENGAME_UPDATE_PROVIDER && env.OPENGAME_UPDATE_PROVIDER !== 'generic') throw new Error('product release: invalid update provider')
  const origin = ownOrigin(env.OPENGAME_UPDATE_ORIGIN)
  const prefix = env.OPENGAME_UPDATE_PATH?.trim()
  if (!prefix || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(prefix)) throw new Error('product release: OPENGAME_UPDATE_PATH must explicitly name a relative publication prefix')
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  const keyPrefix = `${prefix}/feeds/${target}`
  return { environment: resolveDesktopAutoUpdateEnvironment(env), target, origin, keyPrefix,
    binaryKeyPrefix: `${prefix}/bin/${target}`, publicUrl: `${origin}/${keyPrefix}/` }
}
/** @param {NodeJS.ProcessEnv} env Release configuration. @param {NodeJS.Platform} platform Target. @param {string} arch Architecture. @returns {import('./desktop-auto-update-environment.mjs').DesktopUploadConfig} Explicit destination, or refusal. */
export function resolveProductUploadConfig(env, platform, arch) {
  const update = resolveProductUpdateConfig(env, platform, arch)
  if (update === undefined) throw new Error('product release: updates are disabled; upload refused')
  if (env.OPENGAME_UPDATE_PROVIDER === 'github') throw new Error('product release: publish GitHub release assets with the GitHub publication workflow, not COS')
  const prefix = update.environment === 'production' ? 'DOWNLOAD_PROD' : 'DOWNLOAD_TEST'
  const bucket = env[`${prefix}_COS_BUCKET`]?.trim()
  if (!bucket) throw new Error(`product release: ${prefix}_COS_BUCKET is required`)
  return { ...update, bucket, secretIdEnvName: `${prefix}_COS_SECRET_ID`, secretKeyEnvName: `${prefix}_COS_SECRET_KEY` }
}
/** @param {NodeJS.ProcessEnv} env Release configuration. @returns {ReturnType<typeof resolveDesktopPolicyEnvironment> | undefined} Optional independent mandatory policy. */
export function resolveProductMandatoryPolicy(env) {
  if (!productUpdatesEnabled(env)) return undefined
  const deployment = resolveDesktopAutoUpdateEnvironment(env)
  const key = deployment === 'production' ? 'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN' : 'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN'
  if (!env[key]) return undefined
  ownOrigin(env[key])
  return resolveDesktopPolicyEnvironment(env)
}
/** @param {string} resources Packaged resources directory. @returns {Promise<void>} Refuses stale updater metadata, including symlinks. */
export async function assertProductUpdatesAbsent(resources) {
  for (const name of ['app-update.yml', 'dev-app-update.yml']) {
    try { await lstat(join(resources, name)) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error(`product release: updates disabled but ${name} exists`)
  }
}
/** @param {string} appPath macOS bundle. @param {{publicUrl:string} | undefined} update Optional feed. @returns {Promise<void>} Verifies enabled feed or disabled absence. */
export async function verifyProductMacOSUpdateConfig(appPath, update) {
  if (update === undefined) await assertProductUpdatesAbsent(join(appPath, 'Contents', 'Resources'))
  else await verifyMacOSAppUpdateConfig(appPath, update)
}

/** @param {NodeJS.ProcessEnv} env Release configuration. @param {{origin:string,bucket:string,feedKey:string}} run Qualification destination. @returns {void} Rejects upstream qualification overrides outside the product destination. */
export function assertProductQualificationDestination(env, run) {
  const update = resolveProductUploadConfig(env, 'win32', 'x64')
  if (update.origin !== run.origin || update.bucket !== run.bucket || update.publicUrl !== `${run.origin}/${run.feedKey.slice(0, -'nightly.yml'.length)}`) {
    throw new Error('product release: installed update qualification requires a matching product-owned feed; official qualification deployment is unavailable')
  }
}
