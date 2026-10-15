import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { productUpdatesEnabled, resolveProductUpdateConfig, resolveProductUploadConfig, resolveProductMandatoryPolicy, verifyProductMacOSUpdateConfig, assertProductQualificationDestination } from '../scripts/product-release-policy.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
vi.mock('../scripts/windows-sign.mjs', () => ({
  createWindowsTokenSigner: () => () => { throw new Error('must not sign') },
  installWindowsNsisBootstrapSigner: () => undefined,
  resolveWindowsUpdatePublisher: () => 'CN=Fixture',
  scrubWindowsSigningEnvironment: (environment: NodeJS.ProcessEnv) => environment,
}))
const enabled = { OPENGAME_UPDATE_MODE: 'enabled', OPENGAME_UPDATE_ORIGIN: 'https://updates.example.org', OPENGAME_UPDATE_PATH: 'test-product', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' }
it('defaults signed and unsigned packages to no update or mandatory source, and refuses uploads', () => {
  for (const env of [{}, { DSH_DESKTOP_UNSIGNED: '1', ...enabled }]) {
    expect(productUpdatesEnabled(env)).toBe(false)
    expect(resolveProductUpdateConfig(env, 'darwin', 'arm64')).toBeUndefined()
    expect(resolveProductMandatoryPolicy(env)).toBeUndefined()
    expect(() => resolveProductUploadConfig(env, 'darwin', 'arm64')).toThrow('upload refused')
  }
})
it('requires explicit owned origin and publication prefix, sharing feed and upload target', () => {
  const update = resolveProductUpdateConfig(enabled, 'win32', 'x64')
  expect(update?.publicUrl).toBe('https://updates.example.org/test-product/feeds/win-x64/')
  expect(resolveProductUploadConfig({ ...enabled, DOWNLOAD_PROD_COS_BUCKET: 'fixture' }, 'win32', 'x64')).toMatchObject({ ...update, bucket: 'fixture' })
  for (const origin of ['https://download.deepseek.com', 'https://deepseek.com', 'https://x.deepseek.com.', 'http://updates.example.org', 'https://user@updates.example.org', 'https://updates.example.org/path', undefined]) expect(() => resolveProductUpdateConfig({ ...enabled, OPENGAME_UPDATE_ORIGIN: origin }, 'darwin', 'arm64')).toThrow()
  for (const path of [undefined, '', '/absolute', '../outside', 'x//y', 'x?query']) expect(() => resolveProductUpdateConfig({ ...enabled, OPENGAME_UPDATE_PATH: path }, 'darwin', 'arm64')).toThrow()
  expect(() => productUpdatesEnabled({ OPENGAME_UPDATE_MODE: 'typo' })).toThrow()
})
it('verifies absence of stale updater metadata without requiring unsigned artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-update-'))
  try {
    const resources = join(root, 'Contents/Resources'); await mkdir(resources, { recursive: true })
    await expect(verifyProductMacOSUpdateConfig(root, undefined)).resolves.toBeUndefined()
    await writeFile(join(resources, 'app-update.yml'), 'url: https://download.deepseek.com')
    await expect(verifyProductMacOSUpdateConfig(root, undefined)).rejects.toThrow('updates disabled')
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('keeps unsigned builder publish disabled even when update opt-in was supplied', () => {
  const config = createElectronBuilderConfig({ ...enabled, DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: 'com.opengamegen.desktop', DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' })
  expect(config.publish).toBeNull()
  expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
})
it('keeps signing and notarization enabled independently of disabled updates', () => {
  const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.opengamegen.desktop',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Fixture (AAAAAAAAAA)', DSH_DESKTOP_MACOS_TEAM_ID: 'AAAAAAAAAA',
    APPLE_KEYCHAIN_PROFILE: 'fixture-not-used', DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' })
  expect(config.publish).toBeNull()
  expect(config.mac.forceCodeSigning).toBe(true)
  expect(config.mac.notarize).toBe(true)
  expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
})

it('rejects qualification publication overrides before any transport is created', () => {
  const run = { origin: 'https://download-test.deepseek.com', bucket: 'fixture', feedKey: 'qualification/nightly.yml' }
  expect(() => { assertProductQualificationDestination({}, run) }).toThrow('upload refused')
  expect(() => { assertProductQualificationDestination({ ...enabled, DOWNLOAD_PROD_COS_BUCKET: 'fixture' }, run) }).toThrow('product-owned feed')
})
it('guards signed Windows resources against stale updater metadata with signing preserved', async () => {
  const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.opengamegen.desktop',
    DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64' })
  expect(config.publish).toBeNull()
  expect(config.win.forceCodeSigning).toBe(true)
  expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
  const resources = await mkdtemp(join(tmpdir(), 'product-windows-resources-'))
  try {
    await writeFile(join(resources, 'app-update.yml'), 'url: https://download.deepseek.com')
    await expect(config.afterPack({ appOutDir: resources, packager: { getResourcesDir: () => resources } } as unknown as Parameters<typeof config.afterPack>[0])).rejects.toThrow('updates disabled')
  } finally { await rm(resources, { recursive: true, force: true }) }
})

it('enables an explicitly signed production GitHub feed while retaining unsigned and deployment safety gates', () => {
  const env = { OPENGAME_UPDATE_MODE: 'enabled', OPENGAME_UPDATE_PROVIDER: 'github', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' }
  expect(resolveProductUpdateConfig(env, 'darwin', 'arm64')?.publicUrl).toBe('https://github.com/OpenGameGen/agent/releases/latest/download/')
  expect(resolveProductUpdateConfig({ ...env, DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')).toBeUndefined()
  expect(() => resolveProductUpdateConfig({ ...env, DSH_DESKTOP_AUTO_UPDATE_ENV: 'test' }, 'darwin', 'arm64')).toThrow('explicit production')
  expect(() => resolveProductUploadConfig(env, 'darwin', 'arm64')).toThrow('not COS')
  const config = createElectronBuilderConfig({ ...env, DSH_DESKTOP_APP_ID: 'com.opengamegen.desktop', DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64', DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Fixture (AAAAAAAAAA)', DSH_DESKTOP_MACOS_TEAM_ID: 'AAAAAAAAAA', APPLE_KEYCHAIN_PROFILE: 'fixture' })
  expect(config.extraMetadata.dshProductAutoUpdate).toEqual({ channel: 'nightly-arm64', github: true })
  expect(config.publish).toEqual([{ provider: 'generic', url: 'https://github.com/OpenGameGen/agent/releases/latest/download/', channel: 'nightly' }])
})
