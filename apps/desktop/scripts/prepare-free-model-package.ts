/** Stage the pinned external model plugin without weakening pnpm's subdependency policy. */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { downloadPrimaryRuntimeAsset } from '../../../scripts/primary-runtime/prepare.ts'

const NAME = 'dsh-our-free-model'
const PINNED_SOURCE = /^https:\/\/codeload\.github\.com\/Ebony-Vinyl\/dsh-our-free-model\/tar\.gz\/[a-f0-9]{40}$/u

/**
 * Download the CLI's exact locked plugin archive and constrain only that package to local bytes.
 * @param projectRoot Disposable runtime installation directory.
 * @param repositoryRoot Source repository whose CLI manifest and lockfile pin the archive.
 * @param cache Build-owned download cache; every reuse is integrity-checked.
 * @returns Resolves after the verified archive and single-package override are staged.
 */
export async function prepareFreeModelPackage(projectRoot: string, repositoryRoot: string, cache: string): Promise<void> {
  if (resolve(projectRoot) === resolve(repositoryRoot)) throw new Error('free model package: destination must not be the source workspace')
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'apps/cli/package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const source = manifest.dependencies?.[NAME]
  if (source === undefined || !PINNED_SOURCE.test(source)) throw new Error('free model package: expected the reviewed commit-pinned source')
  const lock = yaml.load(readFileSync(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')) as {
    packages?: Record<string, { resolution?: { integrity?: string; tarball?: string } }>
  }
  const resolution = lock.packages?.[`${NAME}@${source}`]?.resolution
  if (resolution?.tarball !== source || typeof resolution.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(resolution.integrity)) {
    throw new Error('free model package: source is not integrity-pinned in the repository lockfile')
  }
  const relativePath = `product-packages/${NAME}.tgz`
  const destination = join(projectRoot, relativePath)
  mkdirSync(join(projectRoot, 'product-packages'), { recursive: true })
  try {
    const digest = Buffer.from(resolution.integrity.slice('sha512-'.length), 'base64').toString('hex')
    const archive = await downloadPrimaryRuntimeAsset(source, digest, cache, 'sha512')
    copyFileSync(archive, destination)
    const workspacePath = join(projectRoot, 'pnpm-workspace.yaml')
    const workspace = yaml.load(readFileSync(workspacePath, 'utf8')) as Record<string, unknown> & { overrides?: Record<string, string> }
    if (workspace.overrides?.[NAME] !== undefined) throw new Error('free model package: conflicting package override')
    workspace.overrides = { ...workspace.overrides, [NAME]: `file:./${relativePath}` }
    writeFileSync(workspacePath, yaml.dump(workspace), { mode: 0o600 })
  } catch (error) {
    rmSync(destination, { force: true })
    throw error
  }
}
