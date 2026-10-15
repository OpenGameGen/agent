import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const cli = fileURLToPath(new URL('../installer/macos/install.mjs', import.meta.url))
async function fixture(root: string, tag: string) {
  const application = join(root, 'payload/OpenGameGen.app')
  await mkdir(join(application, 'Contents/MacOS'), { recursive: true })
  await mkdir(join(application, 'Contents/Resources/runtime/product'), { recursive: true })
  await writeFile(join(application, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.opengamegen.desktop</string><key>CFBundleExecutable</key><string>OpenGameGen</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
  execFileSync('/usr/bin/clang', ['-x','c','-','-o',join(application,'Contents/MacOS/OpenGameGen')], { input:'int main(){return 0;}' })
  await writeFile(join(application, 'Contents/Resources/runtime/product/install-runtime.mjs'), `export async function installCreationRuntime(){console.log('DEPENDENCIES_ONLY_${tag}');return []}`)
  execFileSync('/usr/bin/codesign', ['--force','--sign','-',application], { stdio:'ignore' })
  const result = spawnSync('/usr/bin/codesign',['-d','--verbose=4',application],{ encoding:'utf8' })
  const cdhash = /^CDHash=(\w+)$/mu.exec(result.stderr)?.[1]
  const manifest = join(root, 'manifest.json')
  await writeFile(manifest,JSON.stringify({ cdhash }))
  return { application,manifest }
}

it.skipIf(process.platform !== 'darwin')('installs without launching desktop, reuses an identical signed app, and preserves the replaced product', async () => {
  const root = await mkdtemp(join(tmpdir(),'standalone installer ')); roots.push(root)
  const destination = join(root,'Applications/OpenGameGen.app')
  const first = await fixture(root,'first')
  const run = () => spawnSync(process.execPath,[cli,'--payload',first.application,'--destination',destination,'--manifest',first.manifest],{ encoding:'utf8' })
  const one = run()
  expect(one.status).toBe(0)
  expect(one.stdout).toContain('DEPENDENCIES_ONLY_first')
  expect(one.stdout).toContain('"reused":false')
  const two = run()
  expect(two.status).toBe(0)
  expect(two.stdout).toContain('"reused":true')
  await fixture(root,'second')
  const three = run()
  expect(three.status).toBe(0)
  const previous = (await readdir(dirname(destination))).find(name => name.startsWith('OpenGameGen.app.previous-'))
  expect(previous).toBeDefined()
  expect(await readFile(join(dirname(destination),previous!,'Contents/Resources/runtime/product/install-runtime.mjs'),'utf8')).toContain('first')
  expect(three.stdout).toContain('DEPENDENCIES_ONLY_second')
  const existingHash = createHash('sha256').update(await readFile(join(destination,'Contents/Info.plist'))).digest('hex')
  await writeFile(first.manifest,JSON.stringify({ cdhash:'incorrect' }))
  expect(run().status).not.toBe(0)
  expect(createHash('sha256').update(await readFile(join(destination,'Contents/Info.plist'))).digest('hex')).toBe(existingHash)
},30000)

it.skipIf(process.platform !== 'darwin')('refuses a linked destination and a same-name application owned by another product', async () => {
  const root = await mkdtemp(join(tmpdir(),'standalone installer ownership ')); roots.push(root)
  const payload = await fixture(root,'ownership')
  const destination = join(root,'Applications/OpenGameGen.app')
  await mkdir(dirname(destination),{ recursive:true })
  await symlink(payload.application,destination)
  const run=()=>spawnSync(process.execPath,[cli,'--payload',payload.application,'--destination',destination,'--manifest',payload.manifest],{ encoding:'utf8' })
  expect(run().stderr).toContain('not a link')
  await rm(destination)
  await cp(payload.application,destination,{ recursive:true })
  const info=join(destination,'Contents/Info.plist')
  await writeFile(info,(await readFile(info,'utf8')).replace('com.opengamegen.desktop','com.other.product'))
  expect(run().stderr).toContain('different application')
  expect(await readFile(info,'utf8')).toContain('com.other.product')
},30000)

it('delivers the standalone runtime helper and runs dependency preparation inside Windows customInstall', async () => {
  const installer = await readFile(new URL('../installer/runtime.nsh',import.meta.url),'utf8')
  expect(installer).toContain('!macro customInstall')
  expect(installer).toContain('nsExec::ExecToLog')
  expect(installer).toContain('install-runtime.mjs')
  expect(installer).toContain('IDRETRY opengame_runtime_retry')
  expect(installer).toContain('Abort "$(INSTALLER_RUNTIME_FAILED)"')
  const runtime = await readFile(new URL('../resources/product/install-runtime.mjs',import.meta.url),'utf8')
  expect(runtime).toContain('productRuntimePaths()')
  expect(runtime).not.toContain('dsh --profile')
})

it.skipIf(process.platform !== 'darwin')('online installer downloads a pinned app, installs it, reuses it offline and rejects corrupt archives', async () => {
  const root = await mkdtemp(join(tmpdir(),'online installer ')); roots.push(root)
  const { application, manifest } = await fixture(root,'online')
  const archive = join(root,'desktop.zip')
  execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',application,archive])
  const bytes = await readFile(archive)
  let downloads = 0
  const server = createServer((_request,response) => { downloads++; response.setHeader('Content-Length',bytes.length); response.end(bytes) })
  await new Promise<void>(accept => server.listen(0,'127.0.0.1',accept))
  const resources = join(root,'bootstrap'); await mkdir(resources)
  for (const name of ['install.mjs','install-online.mjs']) await cp(fileURLToPath(new URL(`../installer/macos/${name}`,import.meta.url)),join(resources,name))
  await cp(fileURLToPath(new URL('../resources/godot/download.mjs',import.meta.url)),join(resources,'download.mjs'))
  await cp(fileURLToPath(new URL('../resources/product/identity.mjs',import.meta.url)),join(resources,'identity.mjs'))
  const locked = { ...(JSON.parse(await readFile(manifest,'utf8')) as { cdhash: string }), archive: { name:'desktop.zip',url:`http://127.0.0.1:${(server.address() as { port:number }).port}/desktop.zip`,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex') } }
  await writeFile(join(resources,'install-manifest.json'),JSON.stringify(locked))
  const destination = join(root,'Applications/OpenGameGen.app')
  const run = (target = destination) => promisify(execFile)(process.execPath,[join(resources,'install-online.mjs'),'--destination',target],{ env:{ ...process.env,OPENGAMEGEN_HOME:join(root,'home') } })
  try {
    const result = await run(); expect(result.stdout).toContain('DEPENDENCIES_ONLY_online')
    expect(downloads).toBe(1)
    // A changed release digest cannot reuse an unrelated cached archive.
    const original = locked.archive.sha256
    locked.archive.sha256 = '0'.repeat(64)
    await writeFile(join(resources,'install-manifest.json'),JSON.stringify(locked))
    await expect(run(join(root,'other/OpenGameGen.app'))).rejects.toThrow(/checksum/u)
    locked.archive.sha256 = original
    await writeFile(join(resources,'install-manifest.json'),JSON.stringify(locked))
    await new Promise<void>(accept => server.close(() => { accept() }))
    expect((await run()).stdout).toContain('"reused":true')
  } finally { server.closeAllConnections(); server.close() }
})
