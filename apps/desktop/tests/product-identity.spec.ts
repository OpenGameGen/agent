/** Product ownership boundaries, using real directories and unchanged official sentinels. */
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { PRODUCT, initializeProductApp, productAppId, productEnvironment, productRuntimePaths } from '../resources/product/identity.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { prepareDesktopCli } from '../scripts/prepare-cli.ts'

async function homeFixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'opengamegen-identity-')))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.dsh'))
  await mkdir(join(home, '.agents'))
  await writeFile(join(home, '.dsh', 'sentinel'), 'official data')
  return home
}
it('uses a product data root and agent root despite ambient official settings', async () => {
  const home = await homeFixture()
  const env = { DSH_HOME: join(home, '.dsh'), DSH_AGENTS_HOME: join(home, '.agents'), KEEP: 'kept' }
  expect(productEnvironment(env, home)).toEqual({ ...env, DSH_HOME: join(home, '.opengamegen'), DSH_AGENTS_HOME: join(home, '.opengamegen', 'agents') })
  expect(env.DSH_HOME).toBe(join(home, '.dsh'))
  expect(await readFile(join(home, '.dsh', 'sentinel'), 'utf8')).toBe('official data')
})
it('rejects official roots, their parents and descendants, including symbolic aliases', async () => {
  const home = await homeFixture()
  for (const path of [home, join(home, '.dsh'), join(home, '.dsh', 'nested'), join(home, '.agents'), 'relative']) {
    expect(() => productEnvironment({ OPENGAMEGEN_HOME: path }, home)).toThrow()
  }
  if (process.platform !== 'win32') {
    await symlink(join(home, '.dsh'), join(home, 'alias'))
    expect(() => productEnvironment({ OPENGAMEGEN_HOME: join(home, 'alias', 'nested') }, home)).toThrow()
    await mkdir(join(home, '.opengamegen'))
    await symlink(join(home, '.agents'), join(home, '.opengamegen', 'agents'))
    expect(() => productEnvironment({}, home)).toThrow()
  }
})
it('sets Electron storage and name before callers can take their instance lock', async () => {
  const home = await homeFixture()
  const calls: unknown[][] = []
  const env = { OPENGAMEGEN_HOME: join(home, 'product-home'), OPENGAMEGEN_USER_DATA: join(home, 'electron') }
  const app = { getPath: () => home, setAppLogsPath: () => {},
    setName: (name: string) => { calls.push(['name', name]) },
    setPath: (name: string, path: string) => { calls.push([name, path]) },
  }
  initializeProductApp(app, env)
  expect(calls).toEqual([['name', PRODUCT.name], ['userData', join(home, 'electron')],
    ['sessionData', join(home, 'electron')], ['crashDumps', join(home, 'electron', 'Crashpad')]])
  expect(env).toMatchObject({ DSH_HOME: join(home, 'product-home'), DSH_AGENTS_HOME: join(home, 'product-home', 'agents') })
  for (const path of [join(home, 'DeepSeek Harness'), join(home, '@deepseek-ai', 'dsh-desktop'), join(home, 'product-home')]) {
    expect(() => { initializeProductApp(app, { ...env, OPENGAMEGEN_USER_DATA: path }) }).toThrow()
  }
})
it('packages separate macOS and Windows identities and exports no official command alias', async () => {
  const home = await homeFixture()
  for (const [target, platform, arch] of [['mac-arm64', 'darwin', 'arm64'], ['win-x64', 'win32', 'x64']] as const) {
    const config = createElectronBuilderConfig({ DSH_DESKTOP_BUILD_TARGET: target, DSH_DESKTOP_UNSIGNED: '1' }, platform, arch)
    expect(config).toMatchObject({ appId: 'com.opengamegen.desktop', productName: 'OpenGameGen', protocols: [{ name: 'OpenGameGen', schemes: ['opengamegen'] }], extraMetadata: { name: 'opengamegen-desktop' }, publish: null })
    expect(config.artifactName).toMatch(/^opengamegen-/u)
    const cli = join(home, target, 'cli')
    await mkdir(join(cli, 'bin'), { recursive: true })
    await writeFile(join(cli, 'bin', 'dsh'), 'stale product launcher')
    prepareDesktopCli(cli, platform)
    await expect(readFile(join(cli, 'bin', platform === 'win32' ? 'dsh.cmd' : 'dsh'))).rejects.toMatchObject({ code: 'ENOENT' })
    const launcher = await readFile(join(cli, 'bin', platform === 'win32' ? 'opengamegen.cmd' : 'opengamegen'), 'utf8')
    expect(launcher).toContain(platform === 'win32' ? 'OpenGameGen.exe' : '/MacOS/OpenGameGen')
    expect(launcher).toContain('cli.mjs')
    expect(await readFile(join(cli, 'identity.mjs'), 'utf8')).toContain('com.opengamegen.desktop')
  }
  expect(productAppId({})).toBe(PRODUCT.appId)
  expect(() => productAppId({ DSH_DESKTOP_APP_ID: 'com.deepseek.harness' })).toThrow('requires')
})

it('installer and app dependency paths share the explicit product home and ignore ambient official roots', () => {
  const paths = productRuntimePaths({ OPENGAMEGEN_HOME: '/tmp/opengamegen-runtime-test', DSH_HOME: '/tmp/official-profile' }, '/tmp/user')
  const home = productEnvironment({ OPENGAMEGEN_HOME: '/tmp/opengamegen-runtime-test' }, '/tmp/user').DSH_HOME
  expect(paths).toEqual({ home, environments: join(home, 'dsh-runtimes', 'environments'), godot: join(home, 'dsh-runtimes', 'godot-4.6') })
})
