import { bootCooldownStorage } from './free-model-cooldowns-fixture.ts'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage, resolveRetryPolicy, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Agents, { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import { expect, it, vi } from 'vitest'
import * as recovery from '../src/free-models.ts'

class Adapter extends LlmAdapter {
  calls: string[] = []
  providers: string[] = []
  toolSchemas: string[] = []
  imageRequests: boolean[] = []
  constructor(private readonly code: string, private readonly success: boolean, private readonly useTool = false, private readonly vision = false, private readonly detail: { message: string; status?: number; firstRetryAfterMs?: number; allRetryAfterMs?: number } = { message: 'unavailable' }, private readonly successModel = 'second', private readonly secondStepFailure = false) { super() }
  override async listModels(provider: string) { return ['first', 'account-only', 'too-small', 'second', 'third'].map(id => ({ provider, id, name: id })) }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: this.vision && model !== 'second' ? ['text', 'image'] : ['text'], context: { contextWindow: model === 'first' ? 1048576 : model === 'too-small' ? 16 : 128000 } }
  }
  override imageRequestPricing() { return { priceImages: (images: readonly unknown[]) => images.map(() => ({ visualTokens: 1, text: '' })) } }
  override providerRetryPolicy() {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER'],
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'test')
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options.model)
    this.providers.push(options.provider)
    this.toolSchemas.push(JSON.stringify(options.tools ?? []))
    this.imageRequests.push(options.messages.some(message => message.content.some(block => block.type === 'image')))
    if (this.calls.length > 12) throw new Error('recovery repeated too many calls')
    if (this.success && ((options.model === this.successModel && this.useTool) || (this.secondStepFailure && options.model === 'second')) && this.calls.filter(model => model === options.model).length === 1) {
      const id = ToolCallId('recovery-tool')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'check', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'check', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (this.secondStepFailure && options.model === 'second') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'limited' } } }
    } else if (this.success && options.model === this.successModel) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'OK' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else yield { type: 'finish', reason: { kind: 'error', failure: { code: this.code, ...this.detail, ...(this.detail.allRetryAfterMs !== undefined ? { providerRetryAfterMs: this.detail.allRetryAfterMs } : options.model === 'first' && this.detail.firstRetryAfterMs !== undefined ? { providerRetryAfterMs: this.detail.firstRetryAfterMs } : {}) } } }
  }
}

async function run(code: string, success: boolean, model = 'first', cancelOnRetry = false, priority: string[] = [], useTool = false, vision = false, cold = false, selectionTest?: 'retained' | 'changed' | 'new-turn', audit?: { message: string; status: number; image?: boolean; successModel?: string; noTools?: boolean; secondStepFailure?: boolean; maxSwitches?: number; firstRetryAfterMs?: number; allRetryAfterMs?: number; abortDiscovery?: boolean; cancelImagePreflight?: boolean; toolImage?: boolean; pendingText?: string; visualTokens?: number; storageRoot?: string; beforeNextTurn?: () => void; nextProvider?: string }) {
  const ctx = new Context()
  await bootCooldownStorage(ctx, audit?.storageRoot)
  const { beforeNextTurn: _beforeNextTurn, ...detail } = audit ?? { message: 'unavailable' }
  const adapter = new Adapter(code, success, useTool, vision, detail, audit?.successModel, audit?.secondStepFailure)
  const selection: ModelSelectionRef = { current: { provider: 'our-free-model', model }, assembled: undefined }
  try {
    for (const plugin of [LlmRuntime, SessionStore, Projections, TokenMeter, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin)
    let catalogReady = !cold
    const originalList = adapter.listModels.bind(adapter)
    vi.spyOn(adapter, 'listModels').mockImplementation(async provider => (await originalList(provider)).filter(model => catalogReady || model.id === 'first'))
    ctx.llm.registerModelDiscovery('our-free-model', async () => { catalogReady = true; return [] })
    ctx.llm.registerAdapter(['our-free-model', ...audit?.nextProvider === undefined ? [] : [audit.nextProvider]], adapter)
    if (!audit?.noTools) ctx.tools.register(defineContentToolFixture({ name: 'check', description: 'Check the recovered route', parameters: {},
      async execute() { if (selectionTest === 'changed') selection.current = { provider: 'our-free-model', model: 'third' }; return audit?.toolImage ? [{ type: 'image', attachment: { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png', bytes: 32, width: 1, height: 1 } }] : [{ type: 'text', text: 'checked' }] },
    }))
    await ctx.plugin(retry, {})
    await ctx.plugin(recovery, { provider: 'our-free-model', maxSwitches: audit?.maxSwitches ?? 2, anonymousModelPattern: 'never-match', anonymousModelNamePrefixes: [], fallbackPriorityIds: priority, contextSafetyRatio: 1.25, anonymousModelIds: ['first', 'too-small', 'second', 'third'],
      failureCodes: recovery.parseConfig(JSON.parse(readFileSync(new URL('../../desktop/resources/environments/free-models.json', import.meta.url), 'utf8'))).failureCodes, unavailableMessages: ['has been deprecated'], discoveryTimeoutMs: 1000, settingsNamespace: 'our-free-model' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId(`free-${code}`), { provider: 'our-free-model', model })
    if (audit?.abortDiscovery) {
      const controller = new AbortController()
      const reason = { label: 'fixture non-Error cancellation' }
      vi.spyOn(ctx.llm, 'discoverModels').mockImplementation(async () => { controller.abort(reason); return [] })
      let abortedError: unknown
      try {
        await ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: controller.signal },
          () => Promise.resolve({ provider: 'our-free-model', model: 'removed' }))
      } catch (error) { abortedError = error }
      return { calls: adapter.calls, abortedError, reason }
    }
    if (audit?.visualTokens !== undefined) vi.spyOn(adapter, 'imageRequestPricing').mockReturnValue({
      priceImages: images => images.map(() => ({ visualTokens: audit.visualTokens ?? 0, text: '' })),
    })
    if (audit?.cancelImagePreflight) {
      const resolve = adapter.resolveModel.bind(adapter)
      vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, id) => {
        agent.cancel({ kind: 'user' })
        return resolve(provider, id)
      })
    }
    if (selectionTest) { installModelSelection(agent.ctx, selection); ctx.systemPrompt.section({ name: 'route-test', order: 1, text: 'route={{model}}' }) }
    if (cancelOnRetry) ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry') agent.cancel({ kind: 'user' })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: audit?.pendingText ?? 'go' }, ...(audit?.image ? [{ type: 'image' as const, attachment: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const, bytes: 32, width: 1, height: 1 } }] : [])], source: { kind: 'user' } }))
    await agent.whenIdle()
    if (selectionTest === 'new-turn') {
      audit?.beforeNextTurn?.()
      if (audit?.nextProvider !== undefined) selection.current = { provider: audit.nextProvider, model }
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    if (audit) return { calls: adapter.calls, providers: adapter.providers, toolSchemas: adapter.toolSchemas, imageRequests: adapter.imageRequests, retainedImage: agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'image' && block.offloaded !== true)), ending: agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason }
    if (selectionTest) return { calls: adapter.calls, notices: agent.session.deriveMessages().filter(message => message.source.kind === 'model-selection').map(message => 'summary' in message.source ? message.source.summary : undefined), prompts: agent.session.deriveMessages().filter(message => message.role === 'system').map(message => message.content) }
    return { calls: adapter.calls, model: agent.session.requestHeader()?.config.model }
  } finally { await ctx.fiber.dispose() }
}

it('retries twice then logs a smaller model that fits the actual request', async () => {
  expect(await run('SERVER', true)).toEqual({ calls: ['first', 'first', 'first', 'second'], model: 'second' })
})
it('switches quota failures without repeating the rejected model and stops after finite candidates', async () => {
  expect(await run('RATE_LIMIT', false)).toEqual({ calls: ['first', 'second', 'third'], model: 'third' })
})
it('does not retry malformed requests and replaces stale default ids with the live catalog', async () => {
  expect(await run('CLIENT_ERROR', false, 'removed')).toEqual({ calls: ['first'], model: 'first' })
})

it('cancels scheduled retries without advancing to another model', async () => {
  expect(await run('SERVER', false, 'first', true)).toEqual({ calls: ['first'], model: 'first' })
})

it('rejects incomplete deployment settings', () => {
  expect(() => recovery.parseConfig({ provider: 'our-free-model' })).toThrow('invalid settingsNamespace')
})

it('updates a retired deployment default after the live catalog becomes available', async () => {
  const ctx = new Context()
  await bootCooldownStorage(ctx)
  const saveSelection = vi.fn(async () => undefined)
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Agents)
    await ctx.plugin(Projections)
    await ctx.plugin(TokenMeter)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'our-free-model', model: 'retired' }), saveSelection,
    } as never)
    ctx.llm.registerModelDiscovery('our-free-model', async () => [])
    ctx.llm.registerAdapter(['our-free-model'], new Adapter('SERVER', true))
    await ctx.plugin(recovery, { provider: 'our-free-model', maxSwitches: 2, anonymousModelPattern: 'never-match', anonymousModelNamePrefixes: [], fallbackPriorityIds: [], contextSafetyRatio: 1.25,
      anonymousModelIds: ['first', 'second'], failureCodes: ['SERVER'], unavailableMessages: [], discoveryTimeoutMs: 1000,
      settingsNamespace: 'our-free-model' })
    await new Promise(resolve => setImmediate(resolve))
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'our-free-model', model: 'first' })
  } finally { await ctx.fiber.dispose() }
})

it('prioritizes the alternate pool and skips models whose capacity cannot fit the request', async () => {
  expect(await run('RATE_LIMIT', true, 'first', false, ['third'])).toEqual({ calls: ['first', 'third', 'second'], model: 'second' })
})

it('keeps the recovered route after a real tool result advances the agent step', async () => {
  expect(await run('RATE_LIMIT', true, 'first', false, [], true)).toEqual({ calls: ['first', 'second', 'second'], model: 'second' })
})

it('tries another image-capable route before downgrading to a preferred text-only pool', async () => {
  expect(await run('RATE_LIMIT', true, 'first', false, ['second'], false, true)).toEqual({ calls: ['first', 'third', 'second'], model: 'second' })
})

it('waits for discovery before replacing a selected model missing from a partial startup catalog', async () => {
  expect(await run('RATE_LIMIT', true, 'second', false, [], false, false, true)).toEqual({ calls: ['second'], model: 'second' })
})

for (const code of ['STREAM_CUT', 'EMPTY_RESPONSE']) {
  it(`recovers ${code} with deployed policy and preserves the replacement across tool steps`, async () => {
    expect(await run(code, true, 'first', false, [], true)).toEqual({ calls: ['first', 'second', 'second'], model: 'second' })
  })
  it(`bounds ${code} recovery when every candidate fails`, async () => {
    expect(await run(code, false)).toEqual({ calls: ['first', 'second', 'third'], model: 'third' })
  })
}

it('does not falsely announce a return to the requested model after a recovered tool step', async () => {
  const result = await run('RATE_LIMIT', true, 'first', false, [], true, false, false, 'retained')
  expect(result.calls).toEqual(['first','second','second'])
  expect(result.notices).toEqual([])
  expect(JSON.stringify(result.prompts)).toContain('route=second')
})
it('preserves actual user selection changes', async () => {
  const result = await run('RATE_LIMIT', true, 'first', false, [], true, false, false, 'changed')
  expect(result.notices).toContain('second → third')
  expect(result.calls[2]).toBe('third')
})
it('preserves the next turn returning to its requested selection', async () => {
  const result = await run('RATE_LIMIT', true, 'first', false, [], true, false, false, 'new-turn')
  expect(result.notices).toContain('second → first')
  expect(result.calls).toEqual(['first','second','second','first','second'])
})

const toolUnavailable = 'No endpoints found that support tool use. Try disabling "ask_user_question".'
it('recovers explicit tool incompatibility with every tool schema and retained image preserved', async () => {
  const result = await run('CLIENT_ERROR', true, 'first', false, [], true, true, false, 'retained', { message: toolUnavailable, status: 404, image: true, successModel: 'third' })
  expect(result.calls).toEqual(['first', 'third', 'third'])
  expect(result.imageRequests).toEqual([true, true, true])
  expect(new Set(result.toolSchemas).size).toBe(1)
  expect(result.toolSchemas?.[0]).toContain('check')
  expect(result.ending).toEqual({ kind: 'completed' })
})
it('ends exhausted incompatible tool routes explicitly without disabling tools', async () => {
  const result = await run('CLIENT_ERROR', false, 'first', false, [], false, false, false, 'retained', { message: toolUnavailable, status: 404 })
  expect(result.calls).toEqual(['first', 'second', 'third'])
  expect(new Set(result.toolSchemas).size).toBe(1)
  expect(result.ending).toMatchObject({ kind: 'error', error: { code: 'FREE_MODEL_UNAVAILABLE' } })
})
it.each([
  { message: 'Unknown endpoint', status: 404 },
  { message: 'Invalid schema for function ask_user_question', status: 400 },
  { message: toolUnavailable, status: 403 },
  { message: toolUnavailable, status: 404, noTools: true },
])('does not disguise unrelated request failures as tool route compatibility: %j', async (audit) => {
  const result = await run('CLIENT_ERROR', false, 'first', false, [], false, false, false, undefined, audit)
  expect(result.calls).toEqual(['first'])
  expect(result.ending).toMatchObject({ kind: 'error', error: { code: 'CLIENT_ERROR' } })
})

it('remembers incompatible tool routes across steps but resets the exclusion on a new turn', async () => {
  const result = await run('CLIENT_ERROR', true, 'first', false, [], false, false, false, 'new-turn', { message: toolUnavailable, status: 404, successModel: 'third', secondStepFailure: true })
  expect(result.calls).toEqual(['first', 'second', 'second', 'third', 'first', 'second', 'third'])
  expect(result.ending).toEqual({ kind: 'completed' })
})

it.each([
  { name: 'all compatible routes failed', vision: true, image: true, maxSwitches: 8, code: 'FREE_MODEL_UNAVAILABLE', calls: ['first', 'third'] },
  { name: 'all routes failed exactly at the switch limit', vision: false, image: false, maxSwitches: 2, code: 'FREE_MODEL_UNAVAILABLE', calls: ['first', 'second', 'third'] },
  { name: 'untried compatible routes exceed the switch budget', vision: true, image: true, maxSwitches: 0, code: 'FREE_MODEL_RETRY_LIMIT', calls: ['first'] },
])('reports $name without changing the request or hiding its final failure', async ({ vision, image, maxSwitches, code, calls }) => {
  const result = await run('RATE_LIMIT', false, 'first', false, [], false, vision, false, undefined, {
    message: 'capacity exhausted; retry later', status: 429, image, maxSwitches,
  })
  expect(result.calls).toEqual(calls)
  expect(result.ending).toMatchObject({ kind: 'error', error: { code } })
  expect(JSON.stringify(result.ending)).toContain('capacity exhausted; retry later')
  expect(JSON.stringify(result.ending)).toContain('Retry later or select another available model')
  expect(result.retainedImage).toBe(image)
  if (vision) expect(result.imageRequests?.every(Boolean)).toBe(true)
  expect(new Set(result.toolSchemas).size).toBe(1)
  expect(result.toolSchemas?.[0]).toContain('check')
})

it('retains an earlier route retry time when the final failure has none and preserves continuation instructions', async () => {
  const now = Date.now()
  const result = await run('RATE_LIMIT', false, 'first', false, [], false, true, false, undefined, { message: 'limited', status: 429, image: true, firstRetryAfterMs: 60000 })
  expect(result.calls).toEqual(['first', 'third'])
  const message = JSON.stringify(result.ending)
  expect(message).toContain('first: not before ')
  expect(message).not.toContain('third: not before')
  expect(message).toContain('Keep this conversation and project')
  expect(message).toContain('do not guarantee availability')
  const timestamp = message.match(/first: not before ([0-9T:.\-]+Z)/)?.[1]
  expect(timestamp).toBeDefined()
  expect(Date.parse(timestamp ?? '')).toBeGreaterThanOrEqual(now + 60000)
})
it('omits expired route retry timestamps without inventing a recovery time', async () => {
  const clock = vi.spyOn(Date, 'now')
  let calls = 0
  const base = Date.now()
  clock.mockImplementation(() => base + calls++ * 1000)
  try {
    const result = await run('RATE_LIMIT', false, 'first', false, [], false, false, false, undefined, { message: 'limited', status: 429, firstRetryAfterMs: 1 })
    expect(JSON.stringify(result.ending)).not.toContain('first: not before')
    expect(JSON.stringify(result.ending)).toContain('No future retry time')
  } finally { clock.mockRestore() }
})

it('skips a known cooling route after a tool advances the step', async () => {
  const result = await run('RATE_LIMIT', true, 'first', false, [], false, false, false, undefined, { message: 'limited', status: 429, firstRetryAfterMs: 60000, successModel: 'never', secondStepFailure: true })
  expect(result.calls).toEqual(['first', 'second', 'second', 'third'])
  expect(JSON.stringify(result.ending)).toContain('first: not before')
})

it('preserves non-Error discovery cancellation as Error cause without requesting or switching models', async () => {
  const result = await run('RATE_LIMIT', false, 'removed', false, [], false, false, false, undefined, { message: 'limited', status: 429, abortDiscovery: true })
  expect(result.calls).toEqual([])
  expect(result.abortedError).toBeInstanceOf(Error)
  expect(result.abortedError).toMatchObject({ message: 'Free-model discovery aborted', cause: result.reason })
})


it('skips the requested cooling route on a new turn without dropping images or tools', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
    const result = await run('RATE_LIMIT', true, 'first', false, [], false, true, false, 'new-turn', {
      message: 'limited', status: 429, firstRetryAfterMs: 60000, image: true, successModel: 'third',
    })
    expect(result.calls).toEqual(['first', 'third', 'third'])
    expect(result.imageRequests).toEqual([true, true, true])
    expect(new Set(result.toolSchemas).size).toBe(1)
    expect(result.retainedImage).toBe(true)
  } finally { vi.useRealTimers() }
})

it('returns a cooled route to the candidates after its explicit deadline expires', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const now = new Date('2026-10-13T00:00:00Z').getTime()
    vi.setSystemTime(now)
    const result = await run('RATE_LIMIT', true, 'first', false, [], false, true, false, 'new-turn', {
      message: 'limited', status: 429, firstRetryAfterMs: 60000, image: true, successModel: 'third',
      beforeNextTurn: () => { vi.setSystemTime(now + 60001) },
    })
    expect(result.calls).toEqual(['first', 'third', 'first', 'third'])
  } finally { vi.useRealTimers() }
})

it('does not request cooling routes when all noncooling alternatives are incompatible', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
    const result = await run('RATE_LIMIT', false, 'first', false, [], false, true, false, 'new-turn', {
      message: 'limited', status: 429, allRetryAfterMs: 60000, image: true,
    })
    expect(result.calls).toEqual(['first', 'third'])
    expect(JSON.stringify(result.ending)).toContain('outside known provider cooldowns')
    expect(result.retainedImage).toBe(true)
    expect(result.imageRequests).toEqual([true, true])
  } finally { vi.useRealTimers() }
})


it('does not infer a cooldown without Retry-After and respects an explicit provider change', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
    const unknown = await run('RATE_LIMIT', true, 'first', false, [], false, true, false, 'new-turn', {
      message: 'limited', status: 429, image: true, successModel: 'third',
    })
    expect(unknown.calls).toEqual(['first', 'third', 'first', 'third'])
    const changed = await run('RATE_LIMIT', true, 'first', false, [], false, true, false, 'new-turn', {
      message: 'limited', status: 429, image: true, successModel: 'third', firstRetryAfterMs: 60000, nextProvider: 'manual-provider',
    })
    expect(changed.providers).toEqual(['our-free-model', 'our-free-model', 'manual-provider'])
    expect(changed.calls).toEqual(['first', 'third', 'first'])
  } finally { vi.useRealTimers() }
})

it('preflights text routes before core can omit retained images and keeps tools across steps', async () => {
  const result = await run('SERVER', true, 'second', false, ['third'], true, true, false, 'retained', {
    message: 'fixture', status: 500, image: true, successModel: 'third',
  })
  expect(result.calls).toEqual(['third', 'third'])
  expect(result.imageRequests).toEqual([true, true])
  expect(result.toolSchemas?.[0]).toContain('check')
  expect(result.toolSchemas?.[1]).toBe(result.toolSchemas?.[0])
})

it('stops without any model dispatch when retained images have no compatible free route', async () => {
  const result = await run('SERVER', true, 'second', false, [], false, false, false, undefined, {
    message: 'fixture', status: 500, image: true,
  })
  expect(result.calls).toEqual([])
  expect(JSON.stringify(result)).toContain('FREE_MODEL_NO_COMPATIBLE_ROUTE')
})

it('honors cancellation during image preflight without dispatching the text route or fallback', async () => {
  const result = await run('SERVER', true, 'second', false, ['third'], false, true, false, undefined, {
    message: 'fixture', status: 500, image: true, cancelImagePreflight: true,
  })
  expect(result.calls).toEqual([])
  expect(JSON.stringify(result)).toContain('aborted')
})

it('retains an admitted tool image when no compatible continuation route exists', async () => {
  const result = await run('SERVER', true, 'second', false, [], true, false, false, undefined, {
    message: 'fixture', status: 500, toolImage: true,
  })
  expect(result.calls).toEqual(['second'])
  expect(result.retainedImage).toBe(true)
  expect(JSON.stringify(result.ending)).toContain('FREE_MODEL_NO_COMPATIBLE_ROUTE')
})

it.each(['text', 'visual'] as const)('accounts for pending %s before choosing an image route', async (kind) => {
  const result = await run('SERVER', true, 'second', false, ['third', 'first'], false, true, false, undefined, {
    message: 'fixture', status: 500, image: true, successModel: 'first',
    ...(kind === 'text' ? { pendingText: 'x'.repeat(600000) } : { visualTokens: 150000 }),
  })
  expect(result.calls).toEqual(['first'])
  expect(result.imageRequests).toEqual([true])
})


it('skips a persisted cooling route in a fresh Agent and Host without dropping tools', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'free-agent-restart-'))
  try {
    const audit = { message: 'quota', status: 429, firstRetryAfterMs: 60000, storageRoot }
    const first = await run('RATE_LIMIT', true, 'first', false, [], true, false, false, undefined, audit)
    expect(first.calls).toEqual(['first', 'second', 'second'])
    const second = await run('RATE_LIMIT', true, 'first', false, [], true, false, false, undefined, audit)
    expect(second.calls).toEqual(['second', 'second'])
  } finally { await rm(storageRoot, { recursive: true, force: true }) }
})
