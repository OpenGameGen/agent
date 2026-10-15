import { EventEmitter } from 'node:events'
import { expect, it, vi, beforeEach } from 'vitest'
import type { DesktopUpdateHttpExecutor } from '../src/update-http-executor.ts'
const mock = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<string | null>>(), download: vi.fn<(...args: unknown[]) => Promise<string>>(),
  fetch: vi.fn(),
}))
vi.mock('electron', () => ({ net: { fetch: mock.fetch } }))
vi.mock('../src/update-http-executor.ts', () => ({ DesktopUpdateHttpExecutor: class {
  request(...args: unknown[]) { return mock.request(...args) }
  download(...args: unknown[]) { return mock.download(...args) }
} }))
import { ProductUpdateHttpExecutor } from '../src/product/update-http-executor.ts'
beforeEach(() => {
  mock.request.mockReset(); mock.download.mockReset(); mock.fetch.mockReset()
  mock.fetch.mockImplementation(async () => new Response(new Uint8Array(65536)))
})
it('rejects a metadata page and switches routes without forwarding private headers', async () => {
  mock.request.mockResolvedValueOnce('<html>blocked</html>').mockResolvedValueOnce('version: 1.0.2\nfiles:\n  - url: https://github.com/OpenGameGen/agent/releases/download/v1/a.zip\n    sha512: pinned')
  const executor = new ProductUpdateHttpExecutor(1000)
  await expect(executor.request({ protocol: 'https:', hostname: 'github.com', path: '/OpenGameGen/agent/releases/latest/download/nightly-arm64-mac.yml', headers: { Authorization: 'secret', Accept: '*/*' } })).resolves.toContain('1.0.2')
  expect(mock.request.mock.calls[1]![0]).toMatchObject({ hostname: 'gh-proxy.com', headers: { Accept: '*/*' } })
  const sent = mock.request.mock.calls[1]![0] as { headers: Record<string, string> }
  expect(sent.headers).not.toHaveProperty('Authorization')
})
it('keeps native checksum/progress/cancellation options through checksum failure and failover', async () => {
  mock.download.mockRejectedValueOnce(new Error('ERR_UPDATER_CHECKSUM_MISMATCH')).mockResolvedValueOnce('/cache/update.zip')
  const cancellation = Object.assign(new EventEmitter(), { cancelled: false })
  const onProgress = vi.fn()
  const options = { sha512: 'pinned-native-sha512', cancellationToken: cancellation as unknown as Parameters<DesktopUpdateHttpExecutor['download']>[2]['cancellationToken'], onProgress }
  const executor = new ProductUpdateHttpExecutor(1000)
  await expect(executor.download(new URL('https://github.com/OpenGameGen/agent/releases/download/v1/a.zip'), '/cache/update.zip', options)).resolves.toBe('/cache/update.zip')
  expect(mock.download).toHaveBeenCalledTimes(2)
  for (const call of mock.download.mock.calls) expect(call[2]).toMatchObject(options)
  expect(cancellation.listenerCount('cancel')).toBe(0)
})
it('cancellation aborts probes and never admits a native download', async () => {
  mock.fetch.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
  }))
  const cancellation = Object.assign(new EventEmitter(), { cancelled: false })
  const executor = new ProductUpdateHttpExecutor(1000)
  const work = executor.download(new URL('https://github.com/OpenGameGen/agent/releases/download/v1/a.zip'), '/cache/update.zip', { sha512: 'pinned', cancellationToken: cancellation as unknown as Parameters<DesktopUpdateHttpExecutor['download']>[2]['cancellationToken'] })
  cancellation.cancelled = true; cancellation.emit('cancel')
  await expect(work).rejects.toThrow('cancelled')
  expect(mock.download).not.toHaveBeenCalled()
  expect(cancellation.listenerCount('cancel')).toBe(0)
})
