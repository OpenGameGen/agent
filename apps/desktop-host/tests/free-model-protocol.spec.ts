import { cp, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('applies the maintained external provider patch and preserves structured tools on reasoning-only failures', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'free-model-patch-'))
  try {
    const upstream = resolve(import.meta.dirname, '../../cli/node_modules/dsh-our-free-model')
    const patch = resolve(import.meta.dirname, '../../../patches/dsh-our-free-model@2.1.0.patch')
    await cp(upstream, temporary, { recursive: true, dereference: true })
    // Supports both the original package (pre-install verification) and a pnpm-patched installation.
    try { execFileSync('git', ['apply', '--check', patch], { cwd: temporary, stdio: 'pipe' }) }
    catch {
      execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: temporary, stdio: 'pipe' })
      execFileSync('git', ['apply', '--reverse', patch], { cwd: temporary, stdio: 'pipe' }) }
    execFileSync('git', ['apply', patch], { cwd: temporary, stdio: 'pipe' })
    const result = execFileSync(process.execPath, [join(import.meta.dirname, 'free-model-protocol-fixture.mjs'), temporary], { timeout: 20000, encoding: 'utf8' })
    expect(result).toContain('PASS: 24 adapter cases')
    const idle = execFileSync(process.execPath, [join(import.meta.dirname, 'free-model-idle-fixture.mjs'), temporary], { timeout: 5000, encoding: 'utf8' })
    expect(idle).toContain('PASS: 6 idle reader cases')
  } finally { await rm(temporary, { recursive: true, force: true }) }
}, 30000)
