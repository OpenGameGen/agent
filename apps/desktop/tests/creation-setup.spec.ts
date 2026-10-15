import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { prepareCreationEnvironment, checkCreationEnvironment, type SetupStage } from '../resources/environments/setup.mjs'
import type { EnvironmentLock } from '../resources/environments/runtime.mjs'
import { runCreationSetup } from '../src/product/creation-setup-process.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'creation setup ')); roots.push(root); return root }
const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()
const pythonVersion = spawnSync('python3', ['--version'], { encoding: 'utf8' }).stdout.trim().split(' ')[1]
async function script(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
  await chmod(path, 0o755)
}
const archive = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(
  Object.entries(files).map(([name, value]) => [name, [strToU8(value), { os: 3, attrs: 0o100755 << 16 }]]),
)))

it.skipIf(process.platform === 'win32' || !python)('fresh installation, offline reinstall and automatic repair use real installers with pinned fixture archives', async () => {
  const root = await temporary()
  const payloads = {
    godot: archive({ 'Godot_v4.6-stable_win64_console.exe': '#!/bin/sh\necho 4.6.stable.official.fixture\n' }),
    blender: archive({ 'blender-4.5.14-windows-x64/blender.exe': '#!/bin/sh\necho "Blender 4.5.14 LTS"\n' }),
    templates: archive(Object.fromEntries(['version.txt','macos.zip','windows_release_x86_64.exe','windows_debug_x86_64.exe','web_nothreads_release.zip','web_nothreads_debug.zip'].map(name => [`templates/${name}`, name === 'version.txt' ? '4.6.stable\n' : 'fixture']))),
  }
  const requests: string[] = []
  let online = true
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    const key = request.url?.slice(1) as keyof typeof payloads
    if (!online || !payloads[key]) { response.writeHead(503); response.end(); return }
    response.end(payloads[key])
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture server')
    const asset = (name: keyof typeof payloads) => ({ name: `${name}.zip`, url: `http://127.0.0.1:${address.port}/${name}`,
      size: payloads[name].length, sha256: createHash('sha256').update(payloads[name]).digest('hex') })
    const config = { root: join(root, 'managed'), primaryRuntime: join(root, 'primary'), godotRoot: join(root, 'godot'),
      resources: join(root, 'resources'), godotResources: join(root, 'godot-resources'), godotHome: join(root, 'user'), platform: 'win32' as const, arch: 'x64' }
    await cp(fileURLToPath(new URL('../resources/environments', import.meta.url)), config.resources, { recursive: true })
    await cp(fileURLToPath(new URL('../resources/godot', import.meta.url)), config.godotResources, { recursive: true })
    const node = join(config.primaryRuntime, 'dependencies/node/bin/node.exe')
    const bundledPython = join(config.primaryRuntime, 'dependencies/python/python.exe')
    for (const file of [node, bundledPython]) await mkdir(dirname(file), { recursive: true })
    await symlink(process.execPath, node)
    await symlink(python, bundledPython)
    await script(join(config.primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs'), 'console.log("11.7.0")')
    await writeFile(join(config.primaryRuntime, 'runtime.json'), JSON.stringify({ platform: 'win32', arch: 'x64', node: process.versions.node, python: pythonVersion, pnpm: '11.7.0' }))
    const lock = JSON.parse(await readFile(join(config.resources, 'lock.json'), 'utf8')) as EnvironmentLock
    lock.blender.assets = { 'win32-x64': asset('blender') }
    await writeFile(join(config.resources, 'lock.json'), JSON.stringify(lock))
    await writeFile(join(config.godotResources, 'lock.json'), JSON.stringify({ version: '4.6.stable', release: '4.6-stable', assets: { darwin: asset('godot'), win32: asset('godot'), templates: asset('templates') } }))
    await script(join(config.root, `npm/${lock.npm.version}/bin/npm-cli.js`), `console.log('${lock.npm.version}')`)
    const stages: SetupStage[] = []
    expect(await prepareCreationEnvironment(config, stage => stages.push(stage))).toHaveLength(5)
    expect(requests.sort()).toEqual(['/blender','/godot','/templates'])
    expect(stages.filter(stage => stage.phase === 'ready' && !stage.reused).map(stage => stage.target)).toEqual(['godot','blender','templates'])
    await checkCreationEnvironment(config)
    const npmCli = join(config.root, `npm/${lock.npm.version}/bin/npm-cli.js`)
    await script(npmCli, 'console.log("broken")')
    await expect(checkCreationEnvironment(config)).rejects.toThrow('npm is damaged')
    await script(npmCli, `console.log('${lock.npm.version}')`)
    online = false
    const reused = await prepareCreationEnvironment(config, () => {})
    expect(reused.every(stage => stage.reused)).toBe(true)
    expect(requests).toHaveLength(3)
    const blender = join(config.root, 'blender/4.5.14/blender-4.5.14-windows-x64/blender.exe')
    await writeFile(blender, '#!/bin/sh\necho "Blender 0.0.0"\n')
    const templates = join(config.godotHome, 'AppData/Roaming/Godot/export_templates/4.6.stable')
    await writeFile(join(templates, 'web_nothreads_release.zip'), '')
    await expect(checkCreationEnvironment(config)).rejects.toThrow()
    const repaired = await prepareCreationEnvironment(config, () => {})
    expect(repaired.find(stage => stage.target === 'blender')?.reused).toBe(false)
    expect(repaired.find(stage => stage.target === 'templates')?.reused).toBe(false)
    expect(requests).toHaveLength(3) // Verified caches repair without a second network request.
    expect((await readdir(dirname(templates))).some(name => name.startsWith('4.6.stable.previous-'))).toBe(true)
    expect((await readdir(join(config.root, 'blender'))).some(name => name.startsWith('4.5.14.previous-'))).toBe(true)
    await writeFile(join(config.primaryRuntime, 'runtime.json'), JSON.stringify({ platform: 'win32', arch: 'x64', node: '0.0.0', python: pythonVersion, pnpm: '11.7.0' }))
    await expect(prepareCreationEnvironment(config, () => {})).rejects.toThrow('pinned version')
    expect(requests).toHaveLength(3)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() =>{  resolve() })) }
}, 30000)

it('installer failure is surfaced with bounded diagnostics and the child receives no credentials', async () => {
  const root = await temporary()
  const cli = join(root, 'cli.mjs')
  await writeFile(cli, "console.error('Environment: downloading fixture'); console.error('x'.repeat(10000)); if(process.env.TEST_API_KEY) process.exit(2); process.exit(1)")
  const progress: string[] = []
  const error = await runCreationSetup({ node: process.execPath, cli, config: join(root, 'config'), environment: { ...process.env, TEST_API_KEY: 'fixture' }, signal: new AbortController().signal, onProgress: line => progress.push(line) }).catch((value: unknown) => value)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('failed (1)')
  expect((error as Error).message.length).toBeLessThan(4300)
  expect(progress).toEqual(['Environment: downloading fixture'])
})

it.skipIf(process.platform === 'win32')('cancelling preparation terminates the installer process tree and waits for exit', async () => {
  const root = await temporary()
  const cli = join(root, 'cli.mjs')
  const pidFile = join(root, 'pid')
  await writeFile(cli, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)']); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setTimeout(()=>console.error('Setup: ready'),100); setInterval(()=>{},1000)`)
  const controller = new AbortController()
  const work = runCreationSetup({ node: process.execPath, cli, config: join(root, 'config'), environment: process.env, signal: controller.signal, onProgress: () =>{  controller.abort(new DOMException('cancelled', 'AbortError')) } })
  await expect(work).rejects.toThrow('cancelled')
  const pid = Number(await readFile(pidFile, 'utf8'))
  // The child may briefly be a zombie after SIGKILL; it cannot keep executing.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  expect(state === '' || state.startsWith('Z')).toBe(true)
})
