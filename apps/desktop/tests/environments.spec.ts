import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { prepareRuntimeEnvironment } from '../src/product/runtime-environment.ts'
import { createEnvironmentManager, downloadAsset, withInstallLock } from '../resources/environments/runtime.mjs'
import type { EnvironmentLock, EnvironmentStatus, Health } from '../resources/environments/runtime.mjs'
import { createRuntime as createGodotRuntime, execute } from '../resources/godot/runtime.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'agent environments ')); roots.push(root); return root }
const resources = fileURLToPath(new URL('../resources/environments', import.meta.url))
const godotResources = fileURLToPath(new URL('../resources/godot', import.meta.url))
const lock = JSON.parse(await readFile(join(resources, 'lock.json'), 'utf8')) as EnvironmentLock
const pythonCommand = ['python3', 'python'].find(value => spawnSync(value, ['--version']).status === 0)
const pythonPath = pythonCommand ? spawnSync(pythonCommand, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim() : ''
const pythonVersion = pythonCommand ? spawnSync(pythonCommand, ['--version'], { encoding: 'utf8' }).stdout.trim().split(' ')[1] : ''

async function fixture(root: string, platform: NodeJS.Platform = process.platform) {
  const primaryRuntime = join(root, 'primary')
  const windows = platform === 'win32'
  const node = join(primaryRuntime, 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node')
  const python = join(primaryRuntime, 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']))
  const pnpm = join(primaryRuntime, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  for (const file of [node, python, pnpm]) await mkdir(dirname(file), { recursive: true })
  if (process.platform === 'win32') await copyFile(process.execPath, node)
  else await symlink(process.execPath, node)
  if (pythonPath) {
    if (process.platform === 'win32') await copyFile(pythonPath, python)
    else await symlink(pythonPath, python)
  } else await writeFile(python, '')
  await writeFile(pnpm, 'console.log("11.7.0")')
  await writeFile(join(primaryRuntime, 'runtime.json'), JSON.stringify({ platform, arch: platform === 'win32' ? 'x64' : process.arch,
    node: process.versions.node, python: pythonVersion || '3.12.0', pnpm: '11.7.0' }))
  return { root: join(root, 'managed'), primaryRuntime, godotRoot: join(root, 'godot'), godotResources, resources, lock,
    platform, arch: platform === 'win32' ? 'x64' : process.arch }
}

it('normalizes Windows PATH and ships literal, private launchers without changing the caller environment', async () => {
  const root = await temporary()
  const options = await fixture(root, 'win32')
  const original = { Path: 'C:\\Windows', PATH: 'C:\\Tools', GODOT_RUNTIME_ROOT: options.godotRoot, GODOT_RUNTIME_RESOURCES: godotResources }
  const env = await prepareRuntimeEnvironment(original, { source: resources, root: options.root, primaryRuntime: options.primaryRuntime, platform: 'win32' })
  expect(original.Path).toBe('C:\\Windows')
  expect(env.Path).toBeUndefined()
  expect(env.PATH).toContain(';C:\\Windows;C:\\Tools')
  expect(env.PIP_REQUIRE_VIRTUALENV).toBe('true')
  expect(env.npm_config_prefix).toBeUndefined()
  expect(env.AGENT_ENV_RESOURCES).toBe(resources)
  const cmd = await readFile(join(options.root, 'bin', 'blender.cmd'), 'utf8')
  expect(cmd).toContain('setlocal DisableDelayedExpansion')
  expect(cmd).toContain('"--mode" "blender" %*')
  expect((JSON.parse(await readFile(env.AGENT_ENV_CONFIG!, 'utf8')) as { godotRoot: string }).godotRoot).toBe(options.godotRoot)
})

it.skipIf(process.platform !== 'darwin')('executes new shell commands, reports missing tools without downloading and rejects global pip', async () => {
  const root = await temporary()
  const options = await fixture(root)
  const env = await prepareRuntimeEnvironment({
    ...process.env, GODOT_RUNTIME_ROOT: options.godotRoot, GODOT_RUNTIME_RESOURCES: godotResources,
  }, { source: resources, root: options.root, primaryRuntime: options.primaryRuntime })
  const state = await execute('/bin/sh', ['-c', 'agent-env status'], { env, quiet: true })
  expect(state.code, state.output).toBe(0)
  const value = JSON.parse(state.output) as EnvironmentStatus
  expect(value.blender.source).toBe(value.blender.installed ? 'system' : 'download')
  expect(value.node.executable).toContain(options.primaryRuntime)
  expect(await readdir(options.root)).not.toContain('downloads')
  const version = await execute('/bin/sh', ['-c', 'node --version'], { env, quiet: true })
  expect(version.output.trim()).toBe(process.version)
  const refused = await execute('/bin/sh', ['-c', 'pip install example'], { env, quiet: true })
  expect(refused.code).toBe(1)
  expect(refused.output).toContain('Create project .venv')
  const doctor = await execute('/bin/sh', ['-c', 'agent-env doctor blender'], { env, quiet: true })
  expect(doctor.code).toBe(value.blender.installed ? 0 : 1)
  expect((JSON.parse(doctor.output) as Record<string, Health>).blender?.healthy).toBe(value.blender.installed)
}, 30000)

it('serializes installers and releases locks after a failed operation', async () => {
  const root = await temporary()
  const events: string[] = []
  await Promise.all([withInstallLock(root, async () => { events.push('first'); await new Promise(resolve => setTimeout(resolve, 50)); events.push('done') }),
    withInstallLock(root, async () => { events.push('second') })])
  expect(events.indexOf('done')).toBe(events.indexOf('first') + 1)
  expect(events).toHaveLength(3)
  await expect(withInstallLock(root, async () => { throw new Error('failure') })).rejects.toThrow('failure')
  await expect(access(join(root, 'install.lock'))).rejects.toThrow()
})

it('recovers a dead installer owner under a separate guard', async () => {
  const root = await temporary()
  await writeFile(join(root, 'install.lock'), '2147483647')
  await expect(withInstallLock(root, async () => 'recovered')).resolves.toBe('recovered')
})

it('does not publish a checksum mismatch, cleans temporary bytes and verifies cached downloads', async () => {
  const root = await temporary()
  const bytes = Buffer.from('release fixture')
  const server = createServer((_request, response) => response.end(bytes))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    const asset = { name: 'fixture', url: `http://127.0.0.1:${address.port}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    await expect(downloadAsset({ ...asset, sha256: '0'.repeat(64) }, root)).rejects.toThrow('checksum')
    expect(await readdir(root)).toEqual([])
    const path = await downloadAsset(asset, root)
    await writeFile(path, 'corrupt')
    await downloadAsset(asset, root)
    expect(await readFile(path)).toEqual(bytes)
  } finally { server.close(); server.closeAllConnections() }
})

it.skipIf(!pythonPath || process.platform === 'win32')('installs a locked Windows ZIP, reuses it, and retains a damaged installation during repair', async () => {
  const root = await temporary()
  const options = await fixture(root, 'win32')
  const filename = `blender-${lock.blender.version}-windows-x64/blender.exe`
  const bytes = zipSync({ [filename]: [strToU8(`#!/bin/sh\necho 'Blender ${lock.blender.version}'\n`), { os: 3, attrs: 0o100755 << 16 }] })
  let downloads = 0
  const server = createServer((_request, response) => { downloads++; response.end(bytes) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    const asset = { name: 'fixture.zip', url: `http://127.0.0.1:${address.port}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    const manager = createEnvironmentManager({ ...options, lock: { ...lock, blender: { ...lock.blender, assets: { 'win32-x64': asset } } } })
    await Promise.all([manager.ensure('blender'), manager.ensure('blender')])
    expect(downloads).toBe(1)
    const installed = (await manager.status()).blender.executable
    await writeFile(installed, '#!/bin/sh\necho wrong\n')
    await chmod(installed, 0o755)
    expect((await manager.doctor('blender')).blender?.healthy).toBe(false)
    await expect(manager.ensure('blender')).rejects.toThrow('version mismatch')
    await manager.ensure('blender', true)
    expect((await manager.doctor('blender')).blender?.healthy).toBe(true)
    const entries = await readdir(join(options.root, 'blender'))
    expect(entries.some(name => name.startsWith(lock.blender.version+'.previous-'))).toBe(true)
    expect(downloads).toBe(1)
  } finally { server.close(); server.closeAllConnections() }
})

it.skipIf(!pythonPath || process.platform !== 'darwin')('creates a real isolated Python venv, preserves it and rejects conflicting project versions', async () => {
  const root = await temporary()
  const options = await fixture(root)
  const manager = createEnvironmentManager(options)
  const project = join(root, 'space project')
  await mkdir(project)
  await manager.prepareProject(project, ['python'])
  const interpreter = join(project, '.venv', 'bin', 'python')
  const probe = await execute(interpreter, ['-c', 'import sys; print(sys.prefix != sys.base_prefix)'], { quiet: true })
  expect(probe.output.trim()).toBe('True')
  await writeFile(join(project, '.venv', 'user-file'), 'preserve')
  await manager.prepareProject(project, ['python'])
  expect(await readFile(join(project, '.venv', 'user-file'), 'utf8')).toBe('preserve')
  await writeFile(join(project, '.agent-environment.json'), JSON.stringify({ format: 1, python: '0.0.1' }))
  await expect(manager.prepareProject(project, ['python'])).rejects.toThrow('Project requires python')
  expect(await readFile(join(project, '.venv', 'user-file'), 'utf8')).toBe('preserve')
}, 30000)

it('delivers the environment installer alongside Godot outside ASAR', async () => {
  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.opengamegen.desktop',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_UNSIGNED: '1',
    DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  }, 'win32', 'x64')
  expect(config.extraResources).toContainEqual({
    from: expect.stringContaining(join('targets', 'win-x64', 'runtime', 'environments')) as string, to: 'runtime/environments',
    filter: ['*.mjs', '*.py', '*.yml', 'lock.json', 'free-models.json', 'LICENSE.txt'],
  })
  for (const name of ['cli.mjs', 'runtime.mjs', 'setup.mjs', 'extract.py', 'desktop.patch.yml', 'lock.json', 'LICENSE.txt']) await access(join(resources, name))
})

it.skipIf(!pythonPath || process.platform === 'win32')('repairs an incomplete Godot engine with its own lock and retains the original tree', async () => {
  const root = await temporary()
  const executable = 'Godot_v4.6-stable_win64_console.exe'
  const bytes = zipSync({ [executable]: [strToU8('#!/bin/sh\necho 4.6.stable.official.fixture\n'), { os: 3, attrs: 0o100755 << 16 }] })
  const server = createServer((_request, response) => response.end(bytes))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    const asset = { name: 'fixture.zip', url: `http://127.0.0.1:${address.port}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    const runtime = createGodotRuntime({ root, python: pythonPath, platform: 'win32', arch: 'x64', home: root, appData: root,
      resources: godotResources, lock: { version: '4.6.stable', release: 'fixture', assets: { darwin: asset, win32: asset, templates: asset } } })
    await mkdir(join(root, 'engine'))
    await writeFile(join(root, 'engine', 'user-file'), 'retain')
    await expect(runtime.ensureEngine()).rejects.toThrow('Unfinished')
    await runtime.ensureEngine(true)
    const retained = (await readdir(root)).find(name => name.startsWith('engine.previous-'))
    expect(retained).toBeDefined()
    expect(await readFile(join(root, retained!, 'user-file'), 'utf8')).toBe('retain')
    expect((await execute(runtime.executable, ['--version'], { quiet: true })).output.trim()).toBe('4.6.stable.official.fixture')
  } finally { server.close(); server.closeAllConnections() }
})
