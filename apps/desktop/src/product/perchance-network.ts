/** Network-only Perchance checks through Electron's network stack.
 * @param request - Shell-owned fetch using the system network configuration.
 * @param signal - Cancellation and deadline. @returns Endpoint access, not generation readiness.
 */
export async function checkPerchanceNetwork(
  request: (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<Response>, signal: AbortSignal,
): Promise<{ ok: boolean; code?: string }> {
  try {
    for (const url of ['https://perchance.org/img-generator', 'https://image-generation.perchance.org/embed']) {
      signal.throwIfAborted()
      const response = await request(url, { signal, redirect: 'error' })
      await response.body?.cancel()
      if (!response.ok) return { ok: false, code: `HTTP_${response.status}` }
    }
    return { ok: true }
  } catch (_error) {
    return { ok: false, code: signal.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
      ? 'TIMEOUT' : 'NETWORK_OR_SERVICE_ERROR' }
  }
}
