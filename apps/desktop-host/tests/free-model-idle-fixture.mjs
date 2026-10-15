import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const { readSse } = await import(pathToFileURL(join(process.argv[2], 'src/http.js')))
const bytes = new TextEncoder().encode(': heartbeat\n\n')
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
let unhandled = 0
process.on('unhandledRejection', () => { unhandled++ })
let returned = 0
let cancelled = 0
let rejectRead
const silent = { next: () => new Promise((_, reject) => { rejectRead = reject }), return: () => { returned++; return Promise.reject(new Error('cleanup rejection')) }, cancel: () => { cancelled++; return Promise.reject(new Error('cancel rejection')) } }
await assert.rejects(readSse(silent, () => {}, undefined, 30), { code: 'TIMEOUT' })
assert.equal(returned, 1)
assert.equal(cancelled, 1)
rejectRead(new Error('late read rejection'))
await sleep(10)
let beats = 0
await readSse({ async next() { await sleep(15); return ++beats <= 8 ? { value: bytes, done: false } : { done: true } }, return() {} }, () => {}, undefined, 60)
assert.equal(beats, 9)
const controller = new AbortController()
const abortTimer = setTimeout(() => controller.abort(), 10)
await assert.rejects(readSse({ next: () => new Promise(() => {}), return() {} }, () => {}, controller.signal, 100), { code: 'ABORTED' })
clearTimeout(abortTimer)
await assert.rejects(readSse({ next() { throw new Error('must not read') } }, () => {}, AbortSignal.abort(), 0), { code: 'ABORTED' })
let readerCancelled = 0
const stream = new ReadableStream({ cancel() { readerCancelled++ } })
await assert.rejects(readSse(stream, () => {}, undefined, 30), { code: 'TIMEOUT' })
assert.equal(readerCancelled, 1)
assert.equal(stream.locked, false)
const payloads = []
await readSse(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n')); c.close() } }), value => payloads.push(value), undefined, 30)
assert.deepEqual(payloads, ['{"ok":true}'])
await sleep(50)
assert.equal(unhandled, 0)
console.log('PASS: 6 idle reader cases')
