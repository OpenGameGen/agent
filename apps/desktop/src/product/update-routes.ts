/** Public product routes only; arbitrary URLs and private credentials never go to mirrors. */
export function productUpdateRoutes(url: URL): URL[] {
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/OpenGameGen/agent/releases/') || url.username || url.password || [...url.searchParams.keys()].some(key => key !== 'noCache')) return [url]
  return [url, new URL(`https://gh-proxy.com/${url.href}`), new URL(`https://ghfast.top/${url.href}`)]
}
export function publicMirrorHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(typeof headers === 'object' && headers !== null && !Array.isArray(headers) ? headers : {})) if (/^(?:accept|user-agent|cache-control|range|accept-encoding|content-type)$/iu.test(key) && typeof value === 'string') result[key] = value
  return result
}
export async function rankProductRoutes(routes: URL[],
  fetcher: (input: string, init?: RequestInit) => Promise<Response>, signal: AbortSignal): Promise<URL[]> {
  const scores = await Promise.all(routes.map(async (url, index) => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 6000)
    const started = performance.now()
    try {
      const response = await fetcher(url.href, { headers: { Range: 'bytes=0-65535', 'Accept-Encoding': 'identity' },
        signal: AbortSignal.any([signal, controller.signal]) })
      if (![200, 206].includes(response.status) || !response.body || /text\/html|application\/json/iu.test(response.headers.get('content-type') ?? '')) throw new Error('Unavailable update route')
      if (response.status === 206 && !/^bytes 0-65535\/\d+$/u.test(response.headers.get('content-range') ?? '')) throw new Error('Invalid probe range')
      const reader = response.body.getReader()
      let bytes = 0
      try { while (bytes < 65536) { const part = await reader.read(); if (part.done) break; bytes += part.value.length } }
      finally { await reader.cancel() }
      if (!bytes) throw new Error('Empty probe')
      return { url, index, score: (performance.now() - started) / Math.min(bytes, 65536) }
    } catch { return { url, index, score: Infinity } }
    finally { clearTimeout(timer); controller.abort() }
  }))
  return scores.sort((a, b) => a.score - b.score || a.index - b.index).map(value => value.url)
}
