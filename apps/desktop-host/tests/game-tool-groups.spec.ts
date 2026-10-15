import { writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Llm, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { expect, it } from 'vitest'
import * as groups from '../src/game-tool-groups.ts'
import { registerGodotTools } from '../src/godot-tools.ts'
import { registerGameValidation } from '../src/game-validation.ts'

class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  override async listModels(provider: string) { return [{ provider, id: 'fixture', name: 'fixture' }] }
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text', 'image'] as ('text' | 'image')[], context: { contextWindow: 1048576 } } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const turnCalls = this.calls.length
    const tool = turnCalls === 1 ? 'game_tool_groups' : turnCalls === 2 ? 'workflow' : undefined
    if (tool) {
      const id = ToolCallId(`call-${turnCalls}`)
      const args = tool === 'game_tool_groups' ? '{"action":"enable","group":"coordination"}' : '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function host(defaultMode: 'all' | 'basic' = 'all') {
  const ctx = new Context()
  for (const plugin of [Llm, Sessions, Projections, TokenMeter, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const register = (name: string) => ctx.tools.register(defineContentToolFixture({ name, description: `Fixture ${name}`, parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  for (const name of ['read', 'write', 'edit', 'bash', 'skill', 'read_image', 'godot_project_create', 'load_godot_runtime', 'workflow']) register(name)
  registerGodotTools(ctx, { root: '/fixture', resources: '/fixture', node: '/fixture/node', python: '/fixture/python' }, { idleMs: 1000, requestMs: 1000, maxBytes: 65536 })
  registerGameValidation(ctx, { root: '/fixture', resources: '/fixture', primaryRuntime: '/fixture', buildMs: 1000, operationMs: 1000, idleMs: 1000 }, async () => { throw new Error('Schema tests must not start an engine') })
  const row = await ctx.plugin(groups, { defaultMode })
  await ctx.plugin(AgentLoop, { agents: [] })
  const a = await ctx.agentLoop.create(SessionId('group-a'), { provider: 'fixture', model: 'fixture' })
  const b = await ctx.agentLoop.create(SessionId('group-b'), { provider: 'fixture', model: 'fixture' })
  const names = (agent: Agent) => ctx.tools.schemas(agent).map(tool => tool.name)
  const call = (agent: Agent, args: object, signal = new AbortController().signal) => ctx.tools.execute({ agent, name: 'game_tool_groups', arguments: args, callId: ToolCallId('group-call'), signal })
  return { ctx, adapter, row, a, b, names, call, register }
}

it('is opt-in, reduces actual Godot/browser schemas, and keeps essential tools plus starter', async () => {
  const h = await host()
  try {
    const measure = () => {
      const tools = h.ctx.tools.schemas(h.a)
      return { count: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools)), tokens: h.ctx.tokenMeter.measure(h.a.session, { config: { provider: 'fixture', model: 'fixture' }, tools }).totalTokens }
    }
    const all = measure()
    expect(h.names(h.a)).toEqual(h.names(h.b))
    await h.call(h.a, { action: 'basic' })
    const basic = measure()
    expect(basic.bytes).toBeLessThan(all.bytes)
    expect(basic.tokens).toBeLessThan(all.tokens)
    for (const name of ['read', 'write', 'edit', 'bash', 'skill', 'read_image', 'godot_project_create', 'load_godot_runtime', 'godot_scene_create', 'godot_scene_inspect', 'godot_node_reference', 'godot_edit_batch', 'godot_resource_set', 'game_start', 'game_key', 'game_click_ui', 'game_screenshot', 'game_tree', 'game_state', 'game_assert', 'game_test', 'game_errors', 'game_tool_groups']) expect(h.names(h.a)).toContain(name)
    expect(h.names(h.a)).not.toContain('godot_animation_key')
    expect(h.names(h.b)).toContain('godot_animation_key')
    const measurements: Record<string, typeof basic> = { all, basic }
    for (const group of ['animation', 'tiles', 'styling', 'advanced_testing', 'coordination']) {
      await h.call(h.a, { action: 'basic' })
      await h.call(h.a, { action: 'enable', group })
      measurements[group] = measure()
      expect(measurements[group].bytes).toBeGreaterThan(basic.bytes)
    }
    if (process.env.DSH_GAME_GROUP_AUDIT) writeFileSync(process.env.DSH_GAME_GROUP_AUDIT, JSON.stringify(measurements, null, 2))
    await h.call(h.a, { action: 'all' })
    expect(measure()).toEqual(all)
  } finally { await h.ctx.fiber.dispose() }
})

it('updates late tool registration and restores only its own masks on plugin disposal', async () => {
  const h = await host('basic')
  try {
    h.register('schedule_create')
    h.register('future_starter_tool')
    expect(h.names(h.a)).not.toContain('schedule_create')
    expect(h.names(h.a)).toContain('future_starter_tool')
    await h.call(h.a, { action: 'enable', group: 'coordination' })
    expect(h.names(h.a)).toContain('schedule_create')
    expect(h.names(h.b)).not.toContain('schedule_create')
    const releaseOther = h.b.ctx.tools.restrict({ deny: ['game_metrics'] })
    await h.row.dispose()
    expect(h.names(h.a)).toContain('game_metrics')
    expect(h.names(h.b)).not.toContain('game_metrics')
    expect(h.names(h.a)).not.toContain('game_tool_groups')
    releaseOther()
    expect(h.names(h.b)).toContain('game_metrics')
  } finally { await h.ctx.fiber.dispose() }
})

it('does not mutate a canceled call and rejects invalid group arguments', async () => {
  const h = await host('basic')
  try {
    const before = h.names(h.a)
    const canceled = await h.call(h.a, { action: 'all' }, AbortSignal.abort(new Error('canceled')))
    expect(canceled.isError).toBe(true)
    expect(h.names(h.a)).toEqual(before)
    for (const args of [{ action: 'enable' }, { action: 'basic', group: 'animation' }, { action: 'enable', group: 'unknown' }]) {
      expect((await h.call(h.a, args)).isError).toBe(true)
      expect(h.names(h.a)).toEqual(before)
    }
    await h.row.dispose()
    expect(h.names(h.a)).toContain('game_record')
  } finally { await h.ctx.fiber.dispose() }
})

it('enables a group for the next real AgentLoop call and preserves images and tool history across turns', async () => {
  const h = await host('basic')
  try {
    h.a.followup(createUserMessage({ content: [{ type: 'text', text: 'enable and use workflow' }, { type: 'image', attachment: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 32, width: 1, height: 1 } }], source: { kind: 'user' } }))
    await h.a.whenIdle()
    expect(h.adapter.calls).toHaveLength(3)
    expect(JSON.stringify(h.adapter.calls[0])).toContain('For a simple Godot game task')
    expect(h.adapter.calls[0]!.tools?.map(tool => tool.name)).not.toContain('workflow')
    expect(h.adapter.calls[1]!.tools?.map(tool => tool.name)).toContain('workflow')
    expect(h.a.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    h.a.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await h.a.whenIdle()
    expect(h.adapter.calls[3]!.tools?.map(tool => tool.name)).toContain('workflow')
    expect(h.adapter.calls.every(call => call.messages.some(message => message.content.some(block => block.type === 'image')))).toBe(true)
    expect(h.adapter.calls[3]!.messages.some(message => message.content.some(block => block.type === 'tool-call' && block.name === 'workflow'))).toBe(true)
    expect(h.names(h.b)).not.toContain('workflow')
    await h.call(h.a, { action: 'basic' })
    h.a.followup(createUserMessage({ content: [{ type: 'text', text: 'continue with basic menu' }], source: { kind: 'user' } }))
    await h.a.whenIdle()
    const afterHiding = h.adapter.calls[4]!
    expect(afterHiding.tools?.map(tool => tool.name)).not.toContain('workflow')
    expect(afterHiding.messages.some(message => message.content.some(block => block.type === 'tool-call' && block.name === 'workflow'))).toBe(true)
    expect(afterHiding.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(true)
    await h.call(h.a, { action: 'enable', group: 'coordination' })
    await h.row.dispose()
    expect(JSON.stringify(await h.ctx.systemPrompt.assemble({ scope: h.a }))).not.toContain('For a simple Godot game task')
    const remounted = await h.ctx.plugin(groups, { defaultMode: 'basic' })
    expect(h.names(h.a)).not.toContain('workflow')
    expect(h.a.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true)
    await remounted.dispose()
  } finally { await h.ctx.fiber.dispose() }
})

it('cleans up disposed agents without changing another session or a replacement agent', async () => {
  const h = await host('basic')
  try {
    const handle = await h.ctx.agents.create({ sessionId: SessionId('owned-group'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await h.call(handle.agent, { action: 'enable', group: 'animation' })
    expect(h.names(handle.agent)).toContain('godot_animation_key')
    await handle.dispose()
    h.register('schedule_list')
    expect(h.names(h.b)).not.toContain('schedule_list')
    const replacement = await h.ctx.agents.create({ sessionId: SessionId('replacement-group'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    expect(h.names(replacement.agent)).not.toContain('godot_animation_key')
    expect(h.names(replacement.agent)).toContain('game_tool_groups')
    await replacement.dispose()
  } finally { await h.ctx.fiber.dispose() }
})
