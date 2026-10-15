/** Preserve electron-updater checksum/native signing while adding public GitHub route failover. */
import { net } from 'electron'
import { load } from 'js-yaml'
import { DesktopUpdateHttpExecutor } from '../update-http-executor.ts'
import { productUpdateRoutes, publicMirrorHeaders, rankProductRoutes } from './update-routes.ts'
export class ProductUpdateHttpExecutor extends DesktopUpdateHttpExecutor {
  override async request(...args: Parameters<DesktopUpdateHttpExecutor['request']>): Promise<string | null> {
    const [options, token, data] = args
    const url = new URL(`${options.protocol ?? 'https:'}//${options.hostname ?? options.host}${options.path ?? '/'}`)
    const routes = productUpdateRoutes(url)
    if (routes.length === 1 || data !== undefined && data !== null || options.method && options.method !== 'GET') return super.request(...args)
    for (const route of routes) {
      if (token?.cancelled) throw new Error('Update check cancelled')
      try {
        const response = await super.request({ ...options, hostname: route.hostname, host: route.host,
          protocol: route.protocol, path: route.pathname + route.search,
          headers: route.origin === url.origin ? options.headers : publicMirrorHeaders(options.headers) }, token, data)
        const parsed: unknown = load(response ?? '')
        if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string' || !('files' in parsed) || !Array.isArray(parsed.files) || parsed.files.length === 0
          || !parsed.files.every((file: unknown) => typeof file === 'object' && file !== null && 'url' in file && typeof file.url === 'string'
            && 'sha512' in file && typeof file.sha512 === 'string')) throw new Error('Invalid update metadata')
        return response
      } catch { if (token?.cancelled) throw new Error('Update check cancelled') }
    }
    throw new Error('All product update metadata routes failed')
  }
  override async download(...args: Parameters<DesktopUpdateHttpExecutor['download']>): Promise<string> {
    const [url, destination, options] = args
    const routes = productUpdateRoutes(url)
    if (routes.length === 1) return super.download(...args)
    if (!options.sha512 && !options.sha2) throw new Error('Product update download requires a pinned checksum')
    const controller = new AbortController()
    const isCancelled = (): boolean => controller.signal.aborted
    const cancel = (): void => { controller.abort() }
    options.cancellationToken.on('cancel', cancel)
    if (options.cancellationToken.cancelled) cancel()
    try {
      const ranked = await rankProductRoutes(routes, net.fetch.bind(net), controller.signal)
      for (const route of ranked) {
        if (isCancelled()) throw new Error('Update download cancelled')
        try {
          const downloadOptions = route.origin === url.origin ? options : { ...options, headers: publicMirrorHeaders(options.headers) }
          return await super.download(route, destination, downloadOptions)
        } catch { if (isCancelled()) throw new Error('Update download cancelled') }
      }
      throw new Error('All product update download routes failed integrity or network checks')
    } finally { options.cancellationToken.off('cancel', cancel) }
  }
}
