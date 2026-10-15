/** Shared product downloader. Routes are measured locally; pinned hashes remain the trust boundary. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const defaults = Object.freeze({ probeMs: 6000, sampleBytes: 262144, idleMs: 20000, timeoutMs: 1800000, attempts: 2 })
async function checksum(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function regularSize(path) {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Download cache must be a regular file')
    return entry.size
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
}
function range(response, start, end, total) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '')
  return response.status === 206 && match && Number(match[1]) === start && Number(match[2]) === end && Number(match[3]) === total
}
function validate(response, asset) {
  if (!response.body || ![200, 206].includes(response.status)) throw new Error(`HTTP ${response.status}`)
  if (/text\/html|application\/json/iu.test(response.headers.get('content-type') ?? '')) throw new Error('Download source returned a page instead of an archive')
  const encoding = response.headers.get('content-encoding')
  if (encoding && encoding !== 'identity') throw new Error('Encoded download cannot be verified by byte range')
  if (response.status === 200 && response.headers.has('content-length') && Number(response.headers.get('content-length')) !== asset.size) throw new Error('Download size differs from release lock')
}
/** Options override bounded measurement settings for deterministic local tests. */
export async function downloadPinned(asset, directory, { prefix = 'Environment', ...options } = {}) {
  const policy = { ...defaults, ...options }
  for (const key of Object.keys(defaults)) if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > 2147483647) throw new Error(`Invalid download policy: ${key}`)
  if (!/^[a-f0-9]{64}$/u.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1) throw new Error('Invalid release lock')
  const urls = [...new Set([asset.url, ...(asset.mirrors ?? [])])]
  if (urls.length > 8) throw new Error('Too many download routes')
  for (const value of urls) {
    const url = new URL(value)
    if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Download route must use HTTPS')
  }
  await mkdir(directory, { recursive: true })
  const destination = join(directory, asset.sha256)
  if (await regularSize(destination) === asset.size && await checksum(destination) === asset.sha256) return destination
  // Installation callers serialize this owned cache with their existing process locks.
  const partial = `${destination}.partial`
  if (await regularSize(partial) > asset.size) await rm(partial)
  const log = message => console.error(`${prefix}: ${message}`)
  log(`downloading ${asset.name} (${Math.ceil(asset.size / 1048576)} MiB); testing ${urls.length} routes`)
  const needsProbe = urls.length > 1 || await regularSize(partial) > 0 || options.sampleBytes !== undefined
  const routes = !needsProbe ? [{ url: urls[0], resumable: false, score: 0 }] : await Promise.all(urls.map(async url => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), policy.probeMs)
    const start = performance.now()
    let response
    try {
      const end = Math.min(policy.sampleBytes, asset.size) - 1
      response = await fetch(url, { headers: { Range: `bytes=0-${end}`, 'Accept-Encoding': 'identity' }, signal: controller.signal })
      validate(response, asset)
      const resumable = Boolean(range(response, 0, end, asset.size))
      if (response.status === 206 && !resumable) throw new Error('Invalid probe Content-Range')
      const reader = response.body.getReader()
      let bytes = 0
      while (bytes <= end) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
      }
      await reader.cancel()
      if (bytes < end + 1) throw new Error('Incomplete download probe')
      const elapsed = Math.max(1, performance.now() - start)
      return { url, resumable, score: elapsed * asset.size / Math.min(bytes, end + 1) }
    } catch { return { url, resumable: false, score: Infinity } }
    finally { clearTimeout(timer); controller.abort() }
  }))
  // A timed-out probe is not a permanent ban: include it as a final fallback.
  routes.sort((a, b) => a.score - b.score)
  const failures = []
  for (let round = 0; round < policy.attempts; round++) for (const route of routes) {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), policy.timeoutMs)
    let idle
    let handle
    const heartbeat = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), policy.idleMs) }
    let bytes = route.resumable ? await regularSize(partial) : 0
    try {
      if (bytes === asset.size) {
        if (await checksum(partial) === asset.sha256) {
          await rm(destination, { force: true }); await rename(partial, destination); return destination
        }
        await rm(partial); bytes = 0
      }
      log(`selected ${new URL(route.url).hostname}; ${bytes ? `resuming at ${bytes} bytes` : route.resumable ? 'streaming with resume support' : 'full stream'}`)
      heartbeat()
      const response = await fetch(route.url, { headers: { 'Accept-Encoding': 'identity', ...(bytes ? { Range: `bytes=${bytes}-` } : {}) }, signal: controller.signal })
      validate(response, asset)
      if (bytes && response.status === 200) { bytes = 0; route.resumable = false }
      else if (response.status === 206 && !range(response, bytes, asset.size - 1, asset.size)) throw new Error('Invalid download Content-Range')
      handle = await open(partial, bytes ? 'a' : 'w', 0o600)
      let reported = bytes
      for await (const chunk of response.body) {
        heartbeat()
        if (bytes + chunk.length > asset.size) throw new Error('Archive exceeds locked size')
        let written = 0
        while (written < chunk.length) written += (await handle.write(chunk, written, chunk.length - written)).bytesWritten
        bytes += chunk.length
        if (bytes - reported >= 16 * 1048576) { reported = bytes; log(`${Math.floor(bytes / 1048576)} / ${Math.ceil(asset.size / 1048576)} MiB`) }
      }
      await handle.close(); handle = undefined
      if (bytes !== asset.size) throw new Error('Incomplete archive size')
      if (await checksum(partial) !== asset.sha256) { await rm(partial); throw new Error('Archive failed pinned checksum validation') }
      await rm(destination, { force: true }); await rename(partial, destination)
      log(`verified ${asset.name}`)
      return destination
    } catch (error) {
      failures.push(`${new URL(route.url).hostname}: ${error.name === 'AbortError' ? 'download timed out' : error.message}`)
      log('route failed; switching download source')
    } finally { controller.abort(); clearTimeout(deadline); clearTimeout(idle); await handle?.close() }
  }
  throw new Error(`${prefix} download failed: ${failures.join('; ')}`)
}
