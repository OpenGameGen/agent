import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { prepareGodotEnvironment } from '../src/product/godot-environment.ts'
import { createRuntime, download, execute } from '../resources/godot/runtime.mjs'
import { projectCommand, projectPath, scriptsIn } from '../resources/godot/cli.mjs'
import type { Runtime } from '../resources/godot/runtime.mjs'
import { fileURLToPath } from 'node:url'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root() { const path = await mkdtemp(join(tmpdir(), 'godot integration ')); roots.push(path); return path }
const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { timeout: 5000 }).status === 0)

it('forwards literal arguments through a private launcher and preserves Host PATH', async () => {
  const directory = await root()
  const primary = join(directory, 'primary')
  const windows = process.platform === 'win32'
  const nodeDirectory = join(primary, 'dependencies', 'node', 'bin')
  const pythonDirectory = join(primary, 'dependencies', 'python', ...(windows ? [] : ['bin']))
  await mkdir(nodeDirectory, { recursive: true })
  await mkdir(pythonDirectory, { recursive: true })
  // Link the real Node rather than simulating shell quoting or process execution.
  const { copyFile } = await import('node:fs/promises')
  if (windows) await copyFile(process.execPath, join(nodeDirectory, 'node.exe'))
  else await symlink(process.execPath, join(nodeDirectory, 'node'))
  await writeFile(join(pythonDirectory, windows ? 'python.exe' : 'python3'), '', { mode: 0o755 })
  const resources = join(directory, 'resources')
  await mkdir(resources)
  await writeFile(join(resources, 'cli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));')
  for (const file of ['lock.json', 'extract.py', 'resource-worker.gd', 'vollkorn-edit.gd', 'VOLLKORN_LICENSE.txt']) await writeFile(join(resources, file), '')
  const original: NodeJS.ProcessEnv = { ...process.env, PATH: process.env.PATH ?? '' }
  const environment = await prepareGodotEnvironment(original, { source: resources, root: join(directory, 'managed'), primaryRuntime: primary })
  expect(original.PATH).toBe(process.env.PATH ?? '')
  const command = windows ? 'cmd.exe' : '/bin/bash'
  const args = windows ? ['/d', '/s', '/c', 'godot-project check "space project"'] : ['--noprofile', '--norc', '-c', 'godot-project check "space project"']
  const output = await execute(command, args, { env: environment, quiet: true })
  expect(output.code, output.output).toBe(0)
  const forwarded = JSON.parse(output.output.trim()) as string[]
  expect(forwarded.slice(-2)).toEqual(['check', 'space project'])
  expect(forwarded.slice(4, 6)).toEqual(['--mode', 'project'])
  expect(environment.GODOT_RUNTIME_ROOT).toBe(join(directory, 'managed'))
})

it('normalizes Windows Path casing and creates a quoted CMD launcher', async () => {
  const directory = await root()
  const primary = join(directory, 'primary')
  for (const [path, files] of [[join(primary, 'dependencies', 'node', 'bin'), ['node.exe']], [join(primary, 'dependencies', 'python'), ['python.exe']], [join(directory, 'resources'), ['cli.mjs', 'lock.json', 'extract.py', 'resource-worker.gd', 'vollkorn-edit.gd', 'VOLLKORN_LICENSE.txt']]] as const) {
    await mkdir(path, { recursive: true })
    for (const file of files) await writeFile(join(path, file), '')
  }
  const environment = await prepareGodotEnvironment({ Path: 'C:\\Windows\\System32', PATH: 'C:\\Tools' }, {
    source: join(directory, 'resources'), root: join(directory, 'managed'), primaryRuntime: primary, platform: 'win32',
  })
  expect(environment.Path).toBeUndefined()
  expect(environment.PATH).toContain(';C:\\Windows\\System32;C:\\Tools')
  const script = await readFile(join(directory, 'managed', 'bin', 'godot.cmd'), 'utf8')
  expect(script).toContain('setlocal DisableDelayedExpansion')
  expect(script).toContain('"--mode" "engine" %*')
})

it('stream-verifies downloads and does not publish corrupt archives', async () => {
  const directory = await root()
  const bytes = Buffer.from('pinned Godot fixture')
  let count = 0
  const server = createServer((_request, response) => { count++; response.end(bytes) })
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture port')
    const asset = { url: `http://127.0.0.1:${address.port}/archive`, name: 'fixture.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const path = await download(asset, directory)
    expect(await readFile(path)).toEqual(bytes)
    expect(await download(asset, directory)).toBe(path)
    expect(count).toBe(1)
    const corrupt = { ...asset, sha256: '0'.repeat(64) }
    await expect(download(corrupt, directory)).rejects.toThrow('checksum')
    await expect(access(join(directory, corrupt.sha256))).rejects.toThrow()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((accept, reject) => server.close((error) => { if (error) reject(error); else accept() }))
  }
})

it('detects Godot script errors even when a process exits zero, and bounds hung commands', async () => {
  const outcome = await execute(process.execPath, ['-e', 'process.stderr.write("\\x1b[31mSCRIPT ERROR: Parse Error: broken script\\n")'], { detectErrors: true, quiet: true })
  expect(outcome.code).toBe(1)
  expect(outcome.diagnostic).toBe(true)
  const timedOut = await execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { quiet: true, timeoutMs: 100 })
  expect(timedOut.code).toBe(124)
})

it('requires a project and ignores scripts in caches and symbolic links', async () => {
  const directory = await root()
  await expect(projectPath(directory)).rejects.toThrow('project.godot')
  await writeFile(join(directory, 'project.godot'), 'config_version=5')
  await writeFile(join(directory, 'main.gd'), '')
  await mkdir(join(directory, '.godot'))
  await writeFile(join(directory, '.godot', 'cache.gd'), '')
  expect(await projectPath(directory)).toBe(await realpath(directory))
  expect(await scriptsIn(directory)).toEqual([join(directory, 'main.gd')])
})

it('rejects unknown project commands and missing export presets before installing templates', async () => {
  const directory = await root()
  await writeFile(join(directory, 'project.godot'), 'config_version=5')
  const ensureTemplates = vi.fn(async () => directory)
  const runtime: Runtime = { executable: process.execPath, templates: directory,
    ensureEngine: vi.fn(async () => process.execPath), ensureTemplates,
    status: vi.fn(async () => ({ version: '4.6.stable', executable: process.execPath, templates: directory, engineInstalled: true, templatesInstalled: false })),
  }
  await expect(projectCommand(['unknown'], runtime)).rejects.toThrow('Unknown')
  await expect(projectCommand(['export', directory, 'Windows', 'game.exe'], runtime)).rejects.toThrow('export_presets.cfg')
  expect(ensureTemplates).not.toHaveBeenCalled()
})

it.skipIf(python === undefined)('installs verified templates transactionally and shares the install across runtime homes', async () => {
  const directory = await root()
  const bytes = Buffer.from(zipSync({
    'templates/version.txt': Buffer.from('4.6.stable\n'),
    'templates/macos.zip': Buffer.from('fixture'),
    'templates/windows_release_x86_64.exe': Buffer.from('fixture'),
    'templates/windows_debug_x86_64.exe': Buffer.from('fixture'),
    'templates/web_nothreads_release.zip': Buffer.from('fixture'),
    'templates/web_nothreads_debug.zip': Buffer.from('fixture'),
  }))
  let downloads = 0
  const server = createServer((_request, response) => { downloads++; response.end(bytes) })
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string' || python === undefined) throw new Error('fixture prerequisites unavailable')
    const asset = { name: 'templates.tpz', url: `http://127.0.0.1:${address.port}/templates`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    const lock = { version: '4.6.stable', release: '4.6-stable', assets: { darwin: asset, win32: asset, templates: asset } }
    const shared = { python, platform: 'darwin' as const, home: directory, lock }
    const first = createRuntime({ ...shared, root: join(directory, 'runtime-a') })
    const second = createRuntime({ ...shared, root: join(directory, 'runtime-b') })
    const [one, two] = await Promise.all([first.ensureTemplates(), second.ensureTemplates()])
    expect(one).toBe(two)
    expect(downloads).toBe(1)
    expect((await first.status()).templatesInstalled).toBe(true)
    await writeFile(join(one, 'version.txt'), 'wrong-version')
    await expect(second.ensureTemplates()).rejects.toThrow('unexpected version')
    expect(await readFile(join(one, 'version.txt'), 'utf8')).toBe('wrong-version')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((accept, reject) => server.close((error) => { if (error) reject(error); else accept() }))
  }
})

it.skipIf(python === undefined)('refuses archive paths escaping the staging directory', async () => {
  if (python === undefined) throw new Error('Python unavailable')
  const directory = await root()
  const archive = join(directory, 'bad.zip')
  await writeFile(archive, zipSync({ '../escaped.txt': Buffer.from('unsafe') }))
  const helper = fileURLToPath(new URL('../resources/godot/extract.py', import.meta.url))
  const outcome = await execute(python, [helper, archive, join(directory, 'staging')], { quiet: true })
  expect(outcome.code).not.toBe(0)
  expect(outcome.output).toContain('escapes installation')
  await expect(access(join(directory, 'escaped.txt'))).rejects.toThrow()
})


const localGodot = '/Applications/Godot.app/Contents/MacOS/Godot'
it.skipIf(process.platform !== 'darwin' || spawnSync(localGodot, ['--version']).status !== 0)('real project runs fail on runtime errors while check only validates scripts', async () => {
  const directory = await root()
  const runtime: Runtime = { executable: localGodot, templates: directory,
    ensureEngine: async () => localGodot, ensureTemplates: async () => directory,
    status: async () => ({ version: '4.6.stable', executable: localGodot, templates: directory, engineInstalled: true, templatesInstalled: false }),
  }
  await writeFile(join(directory, 'project.godot'), 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n')
  await writeFile(join(directory, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n')
  await writeFile(join(directory, 'main.gd'), 'extends Node\nfunc _ready():\n\tvar target: Node = null\n\ttarget.get_name()\n')
  expect(await projectCommand(['check', directory], runtime)).toBe(0)
  const raw = await execute(localGodot, ['--headless', '--path', directory, '--quit-after', '2'], { quiet: true })
  expect(raw.code).toBe(0)
  expect(raw.diagnostic).toBe(true)
  expect(await projectCommand(['run', directory, '--headless', '--quit-after', '2'], runtime)).toBe(1)
  await writeFile(join(directory, 'main.gd'), 'extends Node\nfunc _ready():\n\tprint("TARGET_SCENE_READY")\n')
  expect(await projectCommand(['run', directory, '--headless', '--quit-after', '2'], runtime)).toBe(0)
  await writeFile(join(directory, 'unused.gd'), 'extends Node\nfunc broken(:\n')
  expect(await projectCommand(['check', directory], runtime)).not.toBe(0)
}, 30_000)
