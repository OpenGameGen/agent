import { expect, it, vi } from 'vitest'
import { ProductAutomaticDownload } from '../src/product/automatic-update.ts'
import { productUpdateRoutes, publicMirrorHeaders, rankProductRoutes } from '../src/product/update-routes.ts'
it('automatically downloads a checked version once and does not loop on download errors', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const download = vi.fn(async () => { throw new Error('offline') })
  const automatic = new ProductAutomaticDownload(download)
  automatic.observe({ phase: 'available', version: '1.0.1' })
  automatic.observe({ phase: 'available', version: '1.0.1' })
  await Promise.resolve(); await Promise.resolve()
  expect(download).toHaveBeenCalledOnce()
  automatic.observe({ phase: 'error', version: '1.0.1', failedOperation: 'download' })
  automatic.observe({ phase: 'available', version: '1.0.1' })
  automatic.observe({ phase: 'available', version: '1.0.2' })
  await Promise.resolve(); await Promise.resolve()
  expect(download).toHaveBeenCalledTimes(2)
  log.mockRestore()
})
it('disposal cancels queued automatic admission before starting a download', async () => {
  const download = vi.fn(async () => {})
  const automatic = new ProductAutomaticDownload(download)
  automatic.observe({ phase: 'available', version: '1.0.1' })
  automatic.dispose()
  await Promise.resolve()
  expect(download).not.toHaveBeenCalled()
})
it('mirrors only public product URLs and never forwards credentials or signed query URLs', () => {
  expect(productUpdateRoutes(new URL('https://github.com/OpenGameGen/agent/releases/latest/download/nightly-arm64-mac.yml'))).toHaveLength(3)
  for (const url of ['https://github.com/another/project/releases/download/v1/a.zip', 'https://download.deepseek.com/a', 'https://github.com/OpenGameGen/agent/releases/download/v1/a.zip?token=private']) expect(productUpdateRoutes(new URL(url))).toHaveLength(1)
  expect(publicMirrorHeaders({ Authorization: 'private', Cookie: 'private', 'X-Api-Key': 'private', Range: 'bytes=0-65535', Accept: '*/*' })).toEqual({ Range: 'bytes=0-65535', Accept: '*/*' })
})
it('ranks usable archive responses above blocked pages and retains failures as fallbacks', async () => {
  const urls = productUpdateRoutes(new URL('https://github.com/OpenGameGen/agent/releases/download/v1/a.zip'))
  const fetcher = vi.fn(async (url: string) => url.includes('gh-proxy.com') ? new Response(new Uint8Array(65536), { status: 206, headers: { 'Content-Range': 'bytes 0-65535/100000' } }) : new Response('<html>blocked</html>', { headers: { 'Content-Type': 'text/html' } }))
  expect((await rankProductRoutes(urls, fetcher, new AbortController().signal))[0]!.hostname).toBe('gh-proxy.com')
  expect(fetcher).toHaveBeenCalledTimes(3)
})
