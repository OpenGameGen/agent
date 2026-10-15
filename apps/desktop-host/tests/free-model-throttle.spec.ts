import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { installRouteThrottle, parseConfig } from '../src/free-models.ts'

class Adapter extends LlmAdapter {
  calls: { model: string; at: number }[] = []
  failNext = false
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push({ model: options.model, at: Date.now() })
    if (this.failNext) { this.failNext = false; throw new Error('fixture upstream failure') }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['free', 'other'], adapter)
  const scope = await ctx.plugin((child: Context) => { installRouteThrottle(child, 'free', [{ model: 'paced', requests: 2, windowMs: 1000 }]) })
  const call = async (model = 'paced', provider = 'free', signal?: AbortSignal) => {
    const options = { model, provider, messages: [], ...signal === undefined ? {} : { signal } }
    for await (const _chunk of ctx.llm.stream(options)) { /* consume actual middleware */ }
  }
  return { ctx, adapter, scope, call }
}
it('paces concurrent callers sharing a Host while other routes and providers bypass the gate', async () => {
  const f = await fixture()
  try {
    await f.call()
    const next = f.call()
    await f.call('unpaced')
    await f.call('paced', 'other')
    expect(f.adapter.calls).toHaveLength(3)
    await next
    const paced = f.adapter.calls.filter(call => call.model === 'paced')
    expect((paced.at(2)?.at ?? 0) - (paced.at(0)?.at ?? 0)).toBeGreaterThanOrEqual(500)
  } finally { await f.ctx.fiber.dispose() }
})
it('cancels waiting calls without consuming a slot, and dispose aborts queued work', async () => {
  const f = await fixture()
  try {
    await f.call()
    const controller = new AbortController()
    const pending = f.call('paced', 'free', controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    controller.abort()
    await rejected
    expect(f.adapter.calls).toHaveLength(1)
    const queued = f.call()
    const disposed = expect(queued).rejects.toThrow()
    await f.scope.dispose()
    await disposed
    expect(f.adapter.calls).toHaveLength(1)
    await f.call()
    expect(f.adapter.calls).toHaveLength(2)
  } finally { await f.ctx.fiber.dispose() }
})
it('validates configured limits and ships only the evidenced Cohere route', () => {
  const value = JSON.parse(readFileSync(new URL('../../desktop/resources/environments/free-models.json', import.meta.url), 'utf8')) as Record<string, unknown>
  expect(parseConfig(value).routeLimits).toEqual([{ model: 'cohere/north-mini-code:free', requests: 15, windowMs: 60000 }])
  for (const routeLimits of [null, [{ model: '', requests: 15, windowMs: 60000 }], [{ model: 'x', requests: 0, windowMs: 60000 }], [{ model: 'x', requests: 15, windowMs: Infinity }], [{ model: 'x', requests: 1, windowMs: 1000 }, { model: 'x', requests: 1, windowMs: 1000 }]]) {
    expect(() => parseConfig({ ...value, routeLimits })).toThrow('routeLimits')
  }
})
it('keeps concurrent streams inside a rolling window rather than resetting a minute counter', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['free'], adapter)
  installRouteThrottle(ctx, 'free', [{ model: 'paced', requests: 15, windowMs: 1000 }])
  try {
    await Promise.all(Array.from({ length: 17 }, async () => {
      for await (const _chunk of ctx.llm.stream({ provider: 'free', model: 'paced', messages: [] })) { /* consume */ }
    }))
    expect(adapter.calls).toHaveLength(17)
    for (let index = 15; index < adapter.calls.length; index++) {
      expect((adapter.calls.at(index)?.at ?? 0) - (adapter.calls.at(index - 15)?.at ?? 0)).toBeGreaterThanOrEqual(1000)
    }
  } finally { await ctx.fiber.dispose() }
})

it('retains a failed dispatch count without blocking later attempts permanently', async () => {
  const f = await fixture()
  try {
    f.adapter.failNext = true
    await f.call()
    await f.call()
    expect(f.adapter.calls).toHaveLength(2)
    expect((f.adapter.calls.at(1)?.at ?? 0) - (f.adapter.calls.at(0)?.at ?? 0)).toBeGreaterThanOrEqual(500)
  } finally { await f.ctx.fiber.dispose() }
})
