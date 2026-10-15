import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Agents, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { buildModelCatalog } from '../../../packages/api/session-controller/src/catalog.ts'
import { bootCooldownStorage } from './free-model-cooldowns-fixture.ts'
import * as auto from '../src/free-auto.ts'
import { parseConfig } from '../src/free-models.ts'

class Routes extends LlmAdapter {
  calls: GenerateOptions[] = []
  bad = new Set(['first'])
  tool = false
  override listModels(provider: string) {
    return Promise.resolve(['first', 'second', 'paid'].map(id => ({ provider, id, name: id })))
  }
  override resolveModel(provider: string, id: string) {
    return Promise.resolve({ provider, id, name: id, inputModalities: ['text'] as const,
      context: { contextWindow: 128000 }, defaultMaxTokens: 8192 })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.bad.has(options.model)) {
      yield { type: 'text-delta', index: 0, text: 'FAILED PARTIAL ANSWER' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'private' } } }
      return
    }
    if (this.tool && !options.messages.some(message => message.role === 'tool')) {
      const block = { type: 'tool-call' as const, id: ToolCallId('auto-call'), name: 'work', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: 'work', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Healthy answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Healthy answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture() {
  const ctx = new Context()
  await bootCooldownStorage(ctx)
  await ctx.plugin(LlmRuntime)
  const routes = new Routes()
  ctx.llm.registerAdapter(['raw-free', 'paid-provider'], routes)
  const free = parseConfig(JSON.parse(readFileSync(new URL('../../desktop/resources/environments/free-models.json', import.meta.url), 'utf8')))
  const recovery = { ...free, provider: 'raw-free', anonymousModelPattern: 'never', anonymousModelIds: ['first', 'second'],
    fallbackPriorityIds: ['first', 'second'] }
  const fiber = await ctx.plugin(auto, { recovery, routeMs: 1000, maxBufferBytes: 1024 * 1024, hiddenProviders: ['raw-free'] })
  const request: GenerateOptions = { provider: auto.AUTO_PROVIDER, model: auto.AUTO_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], maxTokens: 64 }
  return { ctx, routes, fiber, request }
}
async function collect(ctx: Context, request: GenerateOptions) {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
  return chunks
}

it('silently retries and exposes only the completed response with stable free-auto identity', async () => {
  const { ctx, routes, request } = await fixture()
  try {
    const chunks = await collect(ctx, request)
    expect(routes.calls.map(call => call.model)).toEqual(['first', 'second'])
    expect(JSON.stringify(chunks)).toContain('Healthy answer')
    expect(JSON.stringify(chunks)).not.toContain('FAILED PARTIAL')
    expect(chunks.filter(chunk => chunk.type === 'finish')).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    await collect(ctx, request)
    expect(routes.calls.map(call => call.model)).toEqual(['first', 'second', 'second'])
    expect(request.model).toBe('free-auto')
  } finally { await ctx.fiber.dispose() }
})

it('reports only final exhaustion without exposing failed model ids or private messages', async () => {
  const { ctx, routes, request } = await fixture()
  routes.bad.add('second')
  try {
    const chunks = await collect(ctx, request)
    expect(routes.calls.map(call => call.model)).toEqual(['first', 'second'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'FREE_MODEL_UNAVAILABLE' } } })
    expect(JSON.stringify(chunks)).not.toContain('private')
  } finally { await ctx.fiber.dispose() }
})

it('forwards messages and tool declarations without downgrading to an answer-only request', async () => {
  const { ctx, routes, request } = await fixture()
  request.tools = [{ name: 'work', description: 'Work', parameters: { type: 'object' } }]
  try {
    await collect(ctx, request)
    for (const call of routes.calls) {
      expect(call.messages).toEqual(request.messages); expect(call.tools).toEqual(request.tools)
      expect(call.maxTokens).toBe(64)
    }
  } finally { await ctx.fiber.dispose() }
})

it('projects one free model while retaining internal candidates and paid providers; disposal restores the catalog', async () => {
  const { ctx, fiber } = await fixture()
  try {
    const catalog = await buildModelCatalog(ctx, { provider: 'raw-free', model: 'first' })
    expect(catalog.groups.map(group => group.id)).toEqual(['paid-provider', 'free-auto'])
    expect(catalog.groups.at(-1)?.models.map(model => model.name)).toEqual(['free-auto'])
    expect(catalog.default).toEqual({ provider: 'free-auto', model: 'free-auto' })
    expect((await ctx.llm.listModels('raw-free')).map(model => model.id)).toEqual(['first', 'second', 'paid'])
    await fiber.dispose()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['raw-free', 'paid-provider'])
    expect((await buildModelCatalog(ctx, { provider: 'paid-provider', model: 'paid' })).default.provider).toBe('paid-provider')
  } finally { await ctx.fiber.dispose() }
})

it('a real Agent logs free-auto, migrates an old free selection and emits no model-switch notices', async () => {
  const { ctx, routes } = await fixture()
  try {
    for (const plugin of [SessionStore, Projections, TokenMeter, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('auto-selection'), { provider: 'raw-free', model: 'first' })
    installModelSelection(agent.ctx, { current: { provider: 'raw-free', model: 'first' }, assembled: undefined })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(routes.calls.map(call => call.model)).toEqual(['first', 'second'])
    expect(agent.session.requestHeader()?.config).toMatchObject({ provider: 'free-auto', model: 'free-auto' })
    expect(agent.session.deriveMessages().filter(message => message.source.kind === 'model-selection')).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection').map(event => event.data))
      .toEqual([{ provider: 'free-auto', model: 'free-auto' }])
  } finally { await ctx.fiber.dispose() }
})

it('a real Agent executes only the successful tool call and continues under the logical alias', async () => {
  const { ctx, routes } = await fixture()
  routes.tool = true
  let executions = 0
  try {
    for (const plugin of [SessionStore, Projections, TokenMeter, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin)
    ctx.tools.register(defineContentToolFixture({ name: 'work', description: 'Work', parameters: {},
      execute: async () => { executions++; return [{ type: 'text', text: 'done' }] } }))
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('auto-tools'), { provider: 'free-auto', model: 'free-auto' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(executions).toBe(1)
    expect(routes.calls.map(call => call.model)).toEqual(['first', 'second', 'second'])
    expect(agent.session.requestHeader()?.config.model).toBe('free-auto')
    expect(agent.session.deriveMessages().some(message => message.source.kind === 'model-selection')).toBe(false)
  } finally { await ctx.fiber.dispose() }
})
