import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { prepareFreeModelPackage } from '../scripts/prepare-free-model-package.ts'

const roots: string[] = []
const url = 'https://codeload.github.com/Ebony-Vinyl/dsh-our-free-model/tar.gz/' + 'a'.repeat(40)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'product-free-package-'))
  roots.push(root)
  const source = join(root, 'source'), project = join(root, 'project'), cache = join(root, 'cache')
  for (const path of [join(source, 'apps/cli'), project, cache]) mkdirSync(path, { recursive: true })
  const bytes = Buffer.from('locked archive fixture')
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  const cached = join(cache, createHash('sha512').update(bytes).digest('hex'))
  writeFileSync(cached, bytes)
  writeFileSync(join(source, 'apps/cli/package.json'), JSON.stringify({ dependencies: { 'dsh-our-free-model': url } }))
  writeFileSync(join(source, 'pnpm-lock.yaml'), yaml.dump({ packages: { [`dsh-our-free-model@${url}`]: { resolution: { tarball: url, integrity } } } }))
  writeFileSync(join(project, 'pnpm-workspace.yaml'), yaml.dump({ packages: ['.'], blockExoticSubdeps: true, overrides: { internal: 'file:./internal.tgz' } }))
  return { source, project, cache, cached, bytes }
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('stages exactly locked bytes while retaining the transitive URL security policy', async () => {
  const data = fixture()
  await prepareFreeModelPackage(data.project, data.source, data.cache)
  expect(readFileSync(join(data.project, 'product-packages/dsh-our-free-model.tgz'))).toEqual(data.bytes)
  expect(yaml.load(readFileSync(join(data.project, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({
    packages: ['.'], blockExoticSubdeps: true,
    overrides: { internal: 'file:./internal.tgz', 'dsh-our-free-model': 'file:./product-packages/dsh-our-free-model.tgz' },
  })
})
it('refuses tampered cached bytes before installing an override', async () => {
  const data = fixture()
  writeFileSync(data.cached, 'tampered')
  await expect(prepareFreeModelPackage(data.project, data.source, data.cache)).rejects.toThrow('checksum mismatch')
  expect(existsSync(join(data.project, 'product-packages/dsh-our-free-model.tgz'))).toBe(false)
  expect(readFileSync(join(data.project, 'pnpm-workspace.yaml'), 'utf8')).not.toContain('dsh-our-free-model')
})
it('requires the exact source and integrity from the repository lockfile', async () => {
  const data = fixture()
  writeFileSync(join(data.source, 'pnpm-lock.yaml'), 'packages: {}\n')
  await expect(prepareFreeModelPackage(data.project, data.source, data.cache)).rejects.toThrow('not integrity-pinned')
})
