/** Optional, agent-local presentation of the game's advanced tool families. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'desktop-game-tool-groups'
export const inject = ['agents', 'tools', 'systemPrompt']

/** Opt-in deployment configuration; the ordinary tool surface is the default. */
export interface Config {
  defaultMode?: 'all' | 'basic'
}

const groups = {
  animation: ['godot_animation_bind', 'godot_animation_key', 'godot_animation_track'],
  tiles: ['godot_tile_atlas', 'godot_tile_cell', 'godot_tile_create', 'godot_tileset_create'],
  styling: ['godot_curve_point', 'godot_gradient_point', 'godot_theme_item'],
  advanced_testing: ['game_freeze', 'game_thaw', 'game_step', 'game_record', 'game_replay', 'game_reproduce', 'game_metrics', 'game_watch_signal', 'game_wait_signal'],
  coordination: ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent', 'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list', 'workflow'],
} as const

type Group = keyof typeof groups
interface State {
  mode: 'all' | 'basic'
  enabled: Set<Group>
  denied: string
  release?: (() => void) | undefined
}

/** Apply reversible masks to inherited global tools, never to history or attachments. */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.defaultMode !== undefined && !['all', 'basic'].includes(config.defaultMode)) throw new Error('Invalid game tool group default mode')
  ctx.systemPrompt.section({ name: 'product-game-tool-groups', order: 101,
    text: 'For a simple Godot game task, you may call game_tool_groups(action="basic"). Enable the matching group before using advanced tools, or use action="all" to restore all groups. This is optional; leave unrelated tasks unchanged.',
  })
  const states = new Map<Agent, State>()
  let updating = false
  let disposed = false
  const sync = () => {
    if (updating || disposed) return
    updating = true
    try {
      // Global schemas are the public surface restrict() accepts. Agent-owned
      // local registrations intentionally remain outside this presentation mask.
      const registered = new Set(ctx.tools.schemas().map(tool => tool.name))
      for (const [agent, state] of states) {
        const deny = state.mode === 'all' ? [] : Object.entries(groups)
          .filter(([group]) => !state.enabled.has(group as Group))
          .flatMap(([, names]) => names).filter(tool => registered.has(tool)).sort()
        const signature = deny.join('\n')
        if (state.denied === signature) continue
        // Install first so a failed replacement leaves the old restriction live.
        const release = deny.length === 0 ? undefined : agent.ctx.tools.restrict({ deny })
        state.release?.()
        state.release = release
        state.denied = signature
      }
    } finally { updating = false }
  }
  const attach = (agent: Agent) => {
    if (states.has(agent)) return
    states.set(agent, { mode: config.defaultMode ?? 'all', enabled: new Set(), denied: '' })
    sync()
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    states.delete(agent)
    state?.release?.()
  })
  ctx.on('tools/change', sync)
  ctx.effect(() => () => {
    disposed = true
    for (const state of states.values()) state.release?.()
    states.clear()
  })
  for (const agent of ctx.agents.list()) attach(agent)

  ctx.tools.register(defineTool({
    name: 'game_tool_groups',
    description: 'Optional game tool menu for this session. basic keeps file/skill tools, project creation, essential Godot scene/resource editing, browser start/input/tree/state/assert/screenshot/test and logs. enable restores animation, tiles, styling, advanced_testing (record/replay/frame control/signals/metrics), or coordination (agents/schedules/workflow). all restores every group. status lists enabled groups and currently hidden tools. Changes affect future calls, preserve history/images, and reset when this plugin or session runtime restarts. Enable a group before calling its tools.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'basic', 'enable', 'all'] },
      group: { type: 'string', enum: ['animation', 'tiles', 'styling', 'advanced_testing', 'coordination'] },
    },
    output: { schema: { type: 'string' }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] },
    presentCall: () => ({ card: 'generic', title: 'Game tool groups', kind: 'read' }),
    execute(args, exec) {
      exec.signal.throwIfAborted()
      if (exec.agent === undefined) throw new Error('Game tool groups require an active session')
      if (args.action === 'enable' && args.group === undefined) throw new Error('Specify a group to enable')
      if (args.action !== 'enable' && args.group !== undefined) throw new Error('group is only valid with enable')
      attach(exec.agent)
      const state = states.get(exec.agent)
      if (state === undefined) throw new Error('Game tool group state is unavailable')
      if (args.action === 'basic') { state.mode = 'basic'; state.enabled.clear() }
      if (args.action === 'all') { state.mode = 'all'; state.enabled.clear() }
      if (args.action === 'enable') state.enabled.add(args.group as Group)
      sync()
      return Promise.resolve(JSON.stringify({ mode: state.mode, enabled: state.mode === 'all' ? Object.keys(groups) : [...state.enabled],
        groups: Object.keys(groups), hidden: state.denied === '' ? [] : state.denied.split('\n'),
        note: 'Only this session tool menu changed. Existing history, images and model selection are unchanged.' }))
    },
  }))
}
