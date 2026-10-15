import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadPinned } from '../resources/godot/download.mjs'

const data = Buffer.alloc(8192, 37)
const sha256 = createHash('sha256').update(data).digest('hex')
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'adaptive-download-'))
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ path: req.url, range: req.headers.range })
    if (req.url === '/wrong-range') { res.writeHead(206, { 'content-range': 'bytes 1-8191/8192' }); res.end(data); return }
    if (req.url === '/bad') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('blocked'); return }
    if (req.url === '/corrupt') { res.end(Buffer.alloc(data.length)); return }
    const match = /^bytes=(\d+)-(\d*)$/u.exec(req.headers.range ?? '')
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Number(match[2]) : data.length - 1
    if (req.url === '/stall' && !match) { res.writeHead(200, { 'content-length': data.length }); res.write(data.subarray(0, 2048)); return }
    const send = () => {
      if (req.url !== '/full' && !(req.url === '/changed' && match?.[2] === '') && match) res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 })
      else res.writeHead(200, { 'content-length': data.length })
      res.end(req.url === '/full' || req.url === '/changed' && match?.[2] === '' ? data : data.subarray(start, end + 1))
    }
    if (req.url === '/slow') setTimeout(send, 100)
    else send()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = path => `http://127.0.0.1:${server.address().port}${path}`
  const asset = (path, mirrors = []) => ({ name: 'test.bin', url: url(path), mirrors: mirrors.map(url), sha256, size: data.length })
  try { await run({ root, requests, asset }) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
}
const policy = { sampleBytes: 1024, probeMs: 300, idleMs: 300, timeoutMs: 1000, attempts: 1 }
test('selects fastest usable route and reuses verified cache without network', () => fixture(async ({ root, requests, asset }) => {
  const locked = asset('/slow', ['/bad', '/fast'])
  const result = await downloadPinned(locked, root, policy)
  assert.deepEqual(await readFile(result), data)
  assert.equal(requests.at(-1).path, '/fast')
  const count = requests.length
  await downloadPinned(locked, root, policy)
  assert.equal(requests.length, count)
}))
test('resumes a retained partial with verified Content-Range', () => fixture(async ({ root, requests, asset }) => {
  await writeFile(join(root, `${sha256}.partial`), data.subarray(0, 4096))
  assert.deepEqual(await readFile(await downloadPinned(asset('/fast'), root, policy)), data)
  assert.equal(requests.at(-1).range, 'bytes=4096-')
}))
test('range-ignoring server uses full download and never appends partial', () => fixture(async ({ root, requests, asset }) => {
  await writeFile(join(root, `${sha256}.partial`), data.subarray(0, 4096))
  assert.deepEqual(await readFile(await downloadPinned(asset('/full'), root, policy)), data)
  assert.equal(requests.at(-1).range, undefined)
}))
test('checksum failure discards corrupt data then falls back to a valid route', () => fixture(async ({ root, asset }) => {
  const result = await downloadPinned(asset('/corrupt', ['/slow']), root, policy)
  assert.deepEqual(await readFile(result), data)
}))
test('all blocked routes fail without publishing an archive', () => fixture(async ({ root, asset }) => {
  await assert.rejects(downloadPinned(asset('/bad'), root, policy), /page instead of an archive/u)
  await assert.rejects(readFile(join(root, sha256)), { code: 'ENOENT' })
}))

test('stalled stream switches source and resumes retained verified-length bytes', () => fixture(async ({ root, requests, asset }) => {
  const result = await downloadPinned(asset('/stall', ['/slow']), root, policy)
  assert.deepEqual(await readFile(result), data)
  assert.equal(requests.at(-1).path, '/slow')
  assert.equal(requests.at(-1).range, 'bytes=2048-')
}))
test('server stops honoring Range after probe: safely restarts full stream', () => fixture(async ({ root, asset }) => {
  await writeFile(join(root, `${sha256}.partial`), data.subarray(0, 4096))
  assert.deepEqual(await readFile(await downloadPinned(asset('/changed'), root, policy)), data)
}))

test('forged Content-Range is rejected without publishing cached data', () => fixture(async ({ root, asset }) => {
  await assert.rejects(downloadPinned(asset('/wrong-range'), root, policy), /Invalid download Content-Range/u)
  await assert.rejects(readFile(join(root, sha256)), { code: 'ENOENT' })
}))
