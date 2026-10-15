import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { isDirectEntry } from '../resources/godot/cli.mjs'

const cli = fileURLToPath(new URL('../resources/godot/cli.mjs', import.meta.url))
it('executes the CLI through both canonical and symbolic-link paths', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'godot-cli-entry-'))
  try {
    const alias = join(temporary, 'linked-cli.mjs')
    await symlink(cli, alias)
    for (const path of [cli, alias]) {
      const result = spawnSync(process.execPath, [path], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Invoke godot or godot-project through the desktop launcher')
      expect(await isDirectEntry(path)).toBe(true)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
it('does not run main on import and tolerates missing or non-directory entry paths', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'godot-cli-import-'))
  try {
    const runner = join(temporary, 'importer.mjs')
    await writeFile(runner, `await import(${JSON.stringify(new URL('../resources/godot/cli.mjs', import.meta.url).href)}); console.log('import-only');`)
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('import-only')
    expect(result.stderr).toBe('')
    expect(await isDirectEntry(join(temporary, 'missing.mjs'))).toBe(false)
    expect(await isDirectEntry(join(runner, 'not-a-directory'))).toBe(false)
    expect(await isDirectEntry('')).toBe(false)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
