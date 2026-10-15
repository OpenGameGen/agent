import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { execute } from '../resources/godot/runtime.mjs'
import { ensureLaunchers } from '../resources/godot/launchers.mjs'

it.skipIf(process.platform !== 'darwin')('explicit install restores deleted runtime launchers and forwards spaced arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher repair '))
  const pythonResult = spawnSync('which', ['python3'], { encoding: 'utf8' })
  expect(pythonResult.status).toBe(0)
  const python = pythonResult.stdout.trim()
  const resources = join(root, 'resources'), managed = join(root, 'managed')
  await cp(fileURLToPath(new URL('../resources/godot', import.meta.url)), resources, { recursive: true })
  const archive = join(root, 'fixture.zip')
  const zipped = spawnSync(python, ['-c', 'import zipfile,sys\ni=zipfile.ZipInfo("Godot.app/Contents/MacOS/Godot");i.external_attr=0o100755<<16\nwith zipfile.ZipFile(sys.argv[1],"w") as z:z.writestr(i,"#!/bin/sh\\necho 4.6.stable.official.fixture\\n")', archive], { encoding: 'utf8' })
  expect(zipped.status, zipped.stderr).toBe(0)
  const bytes = await readFile(archive)
  let downloads = 0
  const server = createServer((_request, response) => { downloads++; response.end(bytes) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local server unavailable')
    const asset = { name: 'fixture.zip', url: `http://127.0.0.1:${address.port}/engine`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    await writeFile(join(resources, 'lock.json'), JSON.stringify({ version: '4.6.stable', assets: { darwin: asset } }))
    const cli = join(resources, 'cli.mjs')
    const install = () => execute(process.execPath, [cli, '--runtime', managed, '--python', python, '--mode', 'project', 'install'], { quiet: true, timeoutMs: 15000 })
    for (let i = 0; i < 2; i++) {
      const result = await install()
      expect(result.code, result.output).toBe(0)
      for (const command of ['godot', 'godot4', 'godot-project']) await access(join(managed, 'bin', command))
      const forwarded = await execute(join(managed, 'bin', 'godot-project'), ['check', join(root, 'missing project')], { quiet: true })
      expect(forwarded.code).toBe(1)
      expect(forwarded.output).toContain('missing project')
      if (i === 0) await rm(managed, { recursive: true })
    }
    expect(downloads).toBe(2)
    await rm(join(managed, 'bin'), { recursive: true })
    await writeFile(join(managed, 'bin'), 'block directory creation')
    const failed = await install()
    expect(failed.code).not.toBe(0)
    expect(failed.output).toContain('bin')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects missing or nonabsolute configured interpreters without publishing success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher invalid '))
  try {
    await expect(ensureLaunchers({ root, node: process.execPath, python: 'python3', cli: import.meta.filename })).rejects.toThrow('absolute')
    await expect(ensureLaunchers({ root, node: process.execPath, python: join(root, 'missing'), cli: import.meta.filename })).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})


it.skipIf(process.platform === 'win32')('checks interpreter executability and CLI readability with distinct file semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher dependencies '))
  const node = join(root, 'node'), python = join(root, 'python'), cli = join(root, 'cli.mjs')
  const options = { root: join(root, 'managed'), node, python, cli, platform: 'darwin' as const }
  try {
    for (const file of [node, python]) await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await writeFile(cli, '// CLI need not be executable', { mode: 0o644 })
    await expect(ensureLaunchers(options)).resolves.toBe(join(options.root, 'bin'))
    for (const file of [node, python]) {
      await chmod(file, 0o644)
      await expect(ensureLaunchers(options)).rejects.toThrow()
      await chmod(file, 0o755)
    }
    await chmod(cli, 0o000)
    await expect(ensureLaunchers(options)).rejects.toThrow()
    await chmod(cli, 0o644)
    for (const file of [node, python, cli]) {
      const contents = await readFile(file)
      await rm(file)
      await mkdir(file)
      await expect(ensureLaunchers(options)).rejects.toThrow('not a regular file')
      await rm(file, { recursive: true })
      await writeFile(file, contents, { mode: file === cli ? 0o644 : 0o755 })
    }
    // Windows static generation checks file presence/type, not POSIX execute bits.
    await chmod(node, 0o644)
    await chmod(python, 0o644)
    await expect(ensureLaunchers({ ...options, platform: 'win32' })).resolves.toBe(join(options.root, 'bin'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
