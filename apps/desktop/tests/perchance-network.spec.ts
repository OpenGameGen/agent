import { expect, it, vi } from 'vitest'
import { checkPerchanceNetwork } from '../src/product/perchance-network.ts'

it('checks both fixed endpoints and cancels their bodies without generating images', async () => {
  const cancel = vi.fn(async () => {})
  const request = vi.fn(async () => new Response(new ReadableStream({ cancel })))
  expect(await checkPerchanceNetwork(request, new AbortController().signal)).toEqual({ ok: true })
  expect(request.mock.calls).toHaveLength(2); expect(cancel).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenNthCalledWith(2, 'https://image-generation.perchance.org/embed', expect.objectContaining({ redirect: 'error' }))
})
it('reports image endpoint HTTP errors even if the website is reachable', async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response()).mockResolvedValueOnce(new Response(null, { status: 503 }))
  expect(await checkPerchanceNetwork(request, new AbortController().signal)).toEqual({ ok: false, code: 'HTTP_503' })
})
it('network failures never echo sensitive messages', async () => {
  const result = await checkPerchanceNetwork(async () => { throw new Error('secret') }, new AbortController().signal)
  expect(result).toEqual({ ok: false, code: 'NETWORK_OR_SERVICE_ERROR' })
})
it('an expired deadline is reported separately', async () => {
  const controller = new AbortController(); controller.abort(new DOMException('deadline', 'TimeoutError'))
  const request = vi.fn()
  expect(await checkPerchanceNetwork(request, controller.signal)).toEqual({ ok: false, code: 'TIMEOUT' })
  expect(request).not.toHaveBeenCalled()
})
