import { expect, it, vi } from 'vitest'
import { type StreamChunk } from '@deepseek-ai/dsh-llm'
import { NetworkDiagnostics, diagnosticFailure, type DiagnosticProviders } from '../src/network-diagnostics.ts'
import { networkDiagnosticsPage } from '../src/network-diagnostics-page.ts'
import { parseConfig } from '../src/free-models.ts'
import { readFileSync } from 'node:fs'

const free = parseConfig(JSON.parse(readFileSync(new URL('../../desktop/resources/environments/free-models.json', import.meta.url), 'utf8')))
const config = { free, requestMs: 1000, discoveryMs: 1000 }
function fixture(overrides: Partial<DiagnosticProviders> = {}) {
  const providers: DiagnosticProviders = {
    models: vi.fn(async () => [{ id: 'kilo-auto/free', name: 'Kilo Auto' }, { id: 'openrouter/free', name: 'Router' }, { id: 'paid', name: 'Paid' }]),
    discover: vi.fn(async () => {}),
    stream: vi.fn(async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'OK' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }),
    horde: vi.fn(async () => 'IMAGE_MODELS_AVAILABLE'),
    perchance: vi.fn(async () => 'IMAGE_ENDPOINTS_REACHABLE'), ...overrides,
  }
  return { diagnostics: new NetworkDiagnostics(providers, config), providers }
}
async function settled(diagnostics: NetworkDiagnostics) {
  await vi.waitFor(() => { expect(diagnostics.snapshot().running).toBe(false) })
  return diagnostics.snapshot().rows
}

it('shows only two channels and sends exactly one representative model request', async () => {
  const { diagnostics, providers } = fixture()
  diagnostics.start()
  const rows = await settled(diagnostics)
  expect(rows.map(row => row.id)).toEqual(['models', 'images'])
  expect(rows.every(row => row.status === 'success')).toBe(true)
  expect(rows[0]?.detail).toBe('MODEL_COMPLETED')
  expect(rows[1]?.detail).toBe('BOTH_IMAGES_AVAILABLE')
  expect(providers.stream).toHaveBeenCalledTimes(1)
  expect(providers.stream).toHaveBeenCalledWith('openrouter/free', expect.any(AbortSignal))
  expect(providers.discover).not.toHaveBeenCalled()
  expect(JSON.stringify(rows)).not.toContain('openrouter/free')
})

it('image channel check does not discover models or send inference', async () => {
  const { diagnostics, providers } = fixture()
  diagnostics.start('images'); await settled(diagnostics)
  expect(providers.discover).not.toHaveBeenCalled(); expect(providers.stream).not.toHaveBeenCalled()
  expect(providers.horde).toHaveBeenCalledOnce(); expect(providers.perchance).toHaveBeenCalledOnce()
})

it.each(['horde', 'perchance'] as const)('one available image route is sufficient when %s fails', async (failed) => {
  const { diagnostics } = fixture({ [failed]: async () => { throw new Error('private') } })
  diagnostics.start('images')
  const rows = await settled(diagnostics)
  expect(rows[1]?.status).toBe('success')
  expect(rows[1]?.detail).toBe(failed === 'horde' ? 'PERCHANCE_AVAILABLE' : 'HORDE_AVAILABLE')
})

it('both unavailable image routes produce one failed channel result', async () => {
  const fail = async () => { throw new Error('private') }
  const { diagnostics } = fixture({ horde: fail, perchance: fail })
  diagnostics.start('images')
  expect((await settled(diagnostics))[1]).toMatchObject({ status: 'error', detail: 'IMAGE_CHANNELS_UNAVAILABLE' })
})

it('refuses individual model targets and overlapping runs', async () => {
  const { diagnostics } = fixture()
  expect(() =>{  diagnostics.start('model:openrouter/free') }).toThrow('UNKNOWN_TARGET')
  diagnostics.start('images'); expect(() =>{  diagnostics.start() }).toThrow('BUSY')
  await settled(diagnostics)
})

it('reports rate limits without exposing provider messages or checking other models', async () => {
  const { diagnostics, providers } = fixture({ stream: vi.fn(async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'secret token private URL' } } }
  }) })
  diagnostics.start('models')
  const rows = await settled(diagnostics)
  expect(rows[0]).toMatchObject({ detail: 'RATE_LIMIT', status: 'error' })
  expect(JSON.stringify(rows)).not.toContain('secret')
  expect(providers.stream).toHaveBeenCalledOnce()
})

it.each(([[],
  [{ type: 'reasoning-delta', index: 0, text: 'thinking' }, { type: 'finish', reason: { kind: 'stop' } }],
  [{ type: 'text-delta', index: 0, text: 'partial' }],
] satisfies StreamChunk[][]).map(chunks => ({ chunks })))('requires completed text (%#)', async ({ chunks }) => {
  const { diagnostics } = fixture({ stream: async function* () { yield* chunks } })
  diagnostics.start('models')
  expect((await settled(diagnostics))[0]?.detail).toBe('EMPTY_RESPONSE')
})

it('refreshes the catalog only when no anonymous models are cached', async () => {
  let discovered = false
  const { diagnostics, providers } = fixture({
    models: async () => discovered ? [{ id: 'openrouter/free', name: 'Router' }] : [],
    discover: vi.fn(async () => { discovered = true }),
  })
  diagnostics.start('models'); await settled(diagnostics)
  expect(providers.discover).toHaveBeenCalledOnce(); expect(providers.stream).toHaveBeenCalledOnce()
})

it('empty refreshed catalog produces a channel failure', async () => {
  const { diagnostics } = fixture({ models: async () => [] })
  diagnostics.start('models')
  expect((await settled(diagnostics))[0]?.detail).toBe('NO_FREE_MODELS')
})

it('cancel awaits the current request', async () => {
  const stream = vi.fn(async function* (_model: string, signal: AbortSignal): AsyncIterable<StreamChunk> {
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    signal.throwIfAborted()
  })
  const { diagnostics } = fixture({ stream })
  diagnostics.start('models')
  await vi.waitFor(() => { expect(stream).toHaveBeenCalledOnce() })
  await diagnostics.cancel()
  expect(diagnostics.snapshot().running).toBe(false)
  expect(diagnostics.snapshot().rows[0]?.status).toBe('cancelled')
})

it('timeout codes are safe and distinct', () => {
  const controller = new AbortController(); controller.abort(new DOMException('deadline', 'TimeoutError'))
  expect(diagnosticFailure(new Error('private'), controller.signal)).toBe('TIMEOUT')
})

it('page has two localized channel names and renders results through textContent', () => {
  const zh = networkDiagnosticsPage('nonce', true), en = networkDiagnosticsPage('nonce', false)
  expect(zh).toContain('免费模型通道'); expect(zh).toContain('免费图片通道'); expect(en).toContain('Free image channel')
  expect(zh).toContain('td.textContent=value'); expect(zh).not.toContain('innerHTML')
})
