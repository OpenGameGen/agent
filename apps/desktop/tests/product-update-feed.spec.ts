import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProductUpdateFeed } from '../scripts/product-update-feed.mjs'
it('generates per-architecture native updater metadata with immutable URLs and the exact SHA512', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-feed-'))
  try {
    const archive = join(root, 'opengamegen-desktop-mac-arm64.zip')
    const bytes = Buffer.from('fixture update')
    await writeFile(archive, bytes)
    const result = await createProductUpdateFeed({ archive, version: '1.2.3', target: 'mac-arm64', tag: 'product-v1.2.3' })
    expect(result.filename).toBe('nightly-arm64-mac.yml')
    expect(result.info.files[0]).toEqual({ url: 'https://github.com/OpenGameGen/agent/releases/download/product-v1.2.3/opengamegen-desktop-mac-arm64.zip', size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') })
    await expect(createProductUpdateFeed({ archive, version: '1.2.3+ignored', target: 'mac-arm64', tag: 'v1' })).rejects.toThrow('ordered')
    await expect(createProductUpdateFeed({ archive, version: '1.2.3', target: 'win-x64', tag: 'v1' })).rejects.toThrow('ZIP or signed Windows')
  } finally { await rm(root, { recursive: true, force: true }) }
})
