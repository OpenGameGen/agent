import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import * as desktopGodot from '../src/godot.ts'

const engine = process.env.GODOT_TEST_APP ?? '/Applications/Godot.app'
const available = process.platform === 'darwin' && await access(join(engine, 'Contents/MacOS/Godot')).then(() => true, () => false)

async function setup(mode = 'danger-full-access', idleMs = 60_000) {
  const root = await mkdtemp(join(tmpdir(), 'godot-native-'))
  const ctx = new Context()
  try {
    await mkdir(join(root, 'dependencies/node/bin'), { recursive: true })
    await symlink(process.execPath, join(root, 'dependencies/node/bin/node'))
    await mkdir(join(root, 'engine'))
    await symlink(engine, join(root, 'engine/Godot.app'))
    await writeFile(join(root, 'engine/installed.json'), '{}')
    const project = join(root, 'project')
    await mkdir(project)
    await writeFile(join(project, 'project.godot'), '[application]\nconfig/name="NativeResourceTests"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, agents: AgentRegistry, system: SystemPrompt, tools: ToolRuntime,
      projections: SessionProjections, policy: SandboxPolicy, sandbox: LocalSandbox, subprocess: LocalSubprocessRuntime,
      skills: SkillRegistry, godot: desktopGodot })
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: cordis:agents', '- name: cordis:system', '- name: cordis:tools', '- name: cordis:projections',
      '- name: cordis:policy', '  config:', `    mode: ${mode}`, `    workspaceRoot: ${JSON.stringify(project)}`,
      '- name: cordis:sandbox', '- name: cordis:subprocess', '- name: cordis:skills', '- name: cordis:godot',
      '  config:', `    worker: { idleMs: ${idleMs}, requestMs: 5000, maxBytes: 65536 }`, `    root: ${JSON.stringify(root)}`,
      `    primaryRuntime: ${JSON.stringify(root)}`, `    resources: ${JSON.stringify(fileURLToPath(new URL('../../desktop/resources/godot/', import.meta.url)))}`, '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    let ordinal = 0
    const call = (name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) =>
      ctx.tools.execute({ callId: ToolCallId(`native-${++ordinal}`), name, arguments: { project, ...args }, signal })
    async function ok(name: string, args: Record<string, unknown>) {
      const result = await call(name, args)
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      return result.content.map(block => block.type === 'text' ? block.text : '').join('')
    }
    return { ctx, root, project, call, ok, cleanup: async () => {
      await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
    } }
  } catch (error) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error }
}

it.skipIf(!available)('edits native resource domains in one process and reloads root and dependency changes from disk', async () => {
  const test = await setup()
  const spawn = vi.spyOn(test.ctx.subprocess, 'spawn')
  try {
    await test.ok('godot_resource_create', { path: 'material.tres', type: 'StandardMaterial3D' })
    await test.ok('godot_resource_set', { path: 'material.tres', property: 'roughness', value: '0.1' })
    expect(await readFile(join(test.project, 'material.tres'), 'utf8')).toContain('roughness = 0.1')
    await writeFile(join(test.project, 'material.tres'), (await readFile(join(test.project, 'material.tres'), 'utf8')).replace('roughness = 0.1', 'roughness = 0.75'))
    expect(await test.ok('godot_resource_inspect', { path: 'material.tres' })).toContain('0.75')
    await test.ok('godot_resource_create', { path: 'gradient.tres', type: 'Gradient' })
    await test.ok('godot_gradient_point', { path: 'gradient.tres', offset: 0.5, color: '#ff8800ff' })
    await test.ok('godot_resource_create', { path: 'texture.tres', type: 'GradientTexture2D' })
    await test.ok('godot_resource_reference', { path: 'texture.tres', property: 'gradient', reference: 'gradient.tres' })
    await writeFile(join(test.project, 'gradient.tres'), '[gd_resource type="Gradient" format=3]\n[resource]\nresource_name = "disk-dependency"\n')
    expect(await test.ok('godot_resource_inspect', { path: 'texture.tres', subresource: 'gradient' })).toContain('disk-dependency')
    await test.ok('godot_resource_create', { path: 'curve.tres', type: 'Curve' })
    await test.ok('godot_curve_point', { path: 'curve.tres', x: 0.3, y: 0.8 })
    await test.ok('godot_resource_set', { path: 'curve.tres', property: 'max_domain', value: '2.0' })
    await test.ok('godot_resource_set', { path: 'curve.tres', property: 'max_value', value: '2.0' })
    await test.ok('godot_curve_point', { path: 'curve.tres', x: 1.5, y: 1.5 })
    await test.ok('godot_resource_create', { path: 'animation.tres', type: 'Animation' })
    expect(await test.ok('godot_animation_track', { path: 'animation.tres', node_property: 'Player:position' })).toContain('"track":0')
    await test.ok('godot_animation_key', { path: 'animation.tres', track: 0, time: 0.5, value: 'Vector2(4, 8)' })
    expect(await test.ok('godot_resource_inspect', { path: 'animation.tres' })).toContain('"keys":1')
    await test.ok('godot_resource_create', { path: 'theme.tres', type: 'Theme' })
    await test.ok('godot_theme_item', { path: 'theme.tres', control: 'Button', item: 'font_color', kind: 'color', value: 'Color(1, 0, 0, 1)' })
    await test.ok('godot_resource_create', { path: 'style.tres', type: 'StyleBoxFlat' })
    await test.ok('godot_theme_item', { path: 'theme.tres', control: 'Button', item: 'normal', kind: 'stylebox', reference: 'style.tres' })
    await test.ok('godot_resource_create', { path: 'tiles.tres', type: 'TileSet' })
    await test.ok('godot_tile_atlas', { path: 'tiles.tres', reference: 'texture.tres', source: 0, width: 16, height: 16 })
    await test.ok('godot_tile_create', { path: 'tiles.tres', source: 0, x: 0, y: 0 })
    expect((await test.call('godot_tile_create', { path: 'tiles.tres', source: 0, x: 0, y: 0 })).isError).toBe(true)
    // All successful edits before the rejected duplicate used one actual Godot process.
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0].argv).toContain('--headless')
    expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--editor')
    expect(await readdir(test.project)).not.toContain('addons')
    expect(await readdir(test.project)).not.toContain('resource-worker.gd')
    expect((await test.call('godot_resource_set', { path: 'material.tres', property: 'roughness', value: '"wrong type"' })).isError).toBe(true)
    expect((await test.call('godot_resource_create', { path: '../escaped.tres', type: 'Curve' })).isError).toBe(true)
    expect((await test.call('godot_resource_create', { path: 'curve.tres', type: 'Curve' })).isError).toBe(true)
  } finally { spawn.mockRestore(); await test.cleanup() }
}, 30_000)

it.skipIf(!available)('stops on demand, idle expiry and disposal; restarts after a crash without replaying edits', async () => {
  const test = await setup('danger-full-access', 100)
  const handles: SubprocessHandle[] = []
  const original = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
  const spawn = vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = original(spec); handles.push(handle); return handle
  })
  try {
    expect((await test.call('godot_resource_create', { path: 'curve.tres', type: 'Curve' })).isError).toBe(false)
    const first = handles[0]!
    await first.done
    expect(await first.waitForExit()).toBe(true)
    await vi.waitFor(async () => {
      expect((await readdir(test.project)).filter(name => name.startsWith('.opengame-godot-worker-'))).toEqual([])
    })
    expect((await test.call('godot_resource_inspect', { path: 'curve.tres' })).isError).toBe(false)
    const second = handles[1]!
    second.terminate()
    await second.done
    expect((await test.call('godot_curve_point', { path: 'curve.tres', x: 0.5, y: 0.5 })).isError).toBe(false)
    const third = handles[2]!
    expect((await test.call('godot_worker_stop')).isError).toBe(false)
    expect(await third.waitForExit()).toBe(true)
    expect((await test.call('godot_resource_inspect', { path: 'curve.tres' })).isError).toBe(false)
    const fourth = handles[3]!
    await test.ctx.fiber.dispose()
    expect(await fourth.waitForExit()).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(4)
  } finally { spawn.mockRestore(); await test.cleanup() }
}, 20_000)

it.skipIf(!available)('enforces workspace sandboxing and read-only mutation denial through the executor', async () => {
  const test = await setup('workspace-write')
  const confine = vi.spyOn(test.ctx.sandbox, 'confine')
  try {
    const result = await test.call('godot_resource_create', { path: 'curve.tres', type: 'Curve' })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(confine).toHaveBeenCalledTimes(1)
    expect(confine.mock.calls[0]?.[1].mode).toBe('workspace-write')
    for (const [tool, path, type] of [
      ['godot_scene_create', 'missing/scenes/Main.tscn', 'Node2D'],
      ['godot_resource_create', 'missing/materials/player.tres', 'StandardMaterial3D'],
    ] as const) {
      const missing = await test.call(tool, { path, type })
      expect(missing.isError).toBe(true)
      expect(JSON.stringify(missing.content)).toContain('Parent directory')
      expect(JSON.stringify(missing.content)).toContain('Create the project-local parent directory')
    }
    await expect(access(join(test.project, 'missing'))).rejects.toThrow()
    await symlink(test.root, join(test.project, 'outside'))
    expect((await test.call('godot_resource_create', { path: 'outside/escaped.tres', type: 'Curve' })).isError).toBe(true)
  } finally { confine.mockRestore(); await test.cleanup() }
  const readonly = await setup('read-only')
  try { expect((await readonly.call('godot_resource_create', { path: 'curve.tres', type: 'Curve' })).isError).toBe(true) }
  finally { await readonly.cleanup() }
}, 15_000)

it.skipIf(!available)('cancels an engine operation in flight and allows the next call to restart', async () => {
  const test = await setup()
  const handles: SubprocessHandle[] = []
  const original = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
  const spawn = vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = original(spec); handles.push(handle); return handle
  })
  const abort = new AbortController()
  try {
    await writeFile(join(test.project, 'hang.gd'), 'extends Curve\nfunc _init():\n\tvar file = FileAccess.open("res://started.txt", FileAccess.WRITE)\n\tfile.store_string("started")\n\tfile.close()\n\tOS.delay_msec(10000)\n')
    await writeFile(join(test.project, 'hang.tres'), '[gd_resource type="Curve" load_steps=2 format=3]\n[ext_resource type="Script" path="res://hang.gd" id="1"]\n[resource]\nscript = ExtResource("1")\n')
    const pending = test.call('godot_resource_inspect', { path: 'hang.tres' }, abort.signal)
    await vi.waitFor(async () => { await access(join(test.project, 'started.txt')) }, { timeout: 3000 })
    abort.abort()
    expect((await pending).isError).toBe(true)
    expect(await handles[0]!.waitForExit()).toBe(true)
    expect((await test.call('godot_resource_create', { path: 'fresh.tres', type: 'Curve' })).isError).toBe(false)
    // The same blocked constructor is also bounded by the configured request deadline.
    expect((await test.call('godot_resource_inspect', { path: 'hang.tres' })).isError).toBe(true)
    expect(await handles[1]!.waitForExit()).toBe(true)
    expect((await test.call('godot_resource_inspect', { path: 'fresh.tres' })).isError).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(3)
  } finally { abort.abort(); spawn.mockRestore(); await test.cleanup() }
}, 15_000)

it.skipIf(!available)('uses the pinned Vollkorn native scene, node, ownership and animation editing code in one worker', async () => {
  const test = await setup()
  const spawn = vi.spyOn(test.ctx.subprocess, 'spawn')
  try {
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node2D' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Player', type: 'CharacterBody2D' })
    await test.ok('godot_node_set', { path: 'world.tscn', node: 'Player', property: 'position', value: '[48, 32]' })
    await test.ok('godot_resource_create', { path: 'shape.tres', type: 'RectangleShape2D' })
    await test.ok('godot_resource_set', { path: 'shape.tres', property: 'size', value: '[12, 20]' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'Player', name: 'Collision', type: 'CollisionShape2D' })
    await test.ok('godot_node_reference', { path: 'world.tscn', node: 'Player/Collision', property: 'shape', reference: 'shape.tres' })
    expect(await readFile(join(test.project, 'shape.tres'), 'utf8')).toContain('size = Vector2(12, 20)')
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toContain('res://shape.tres')
    expect(await test.ok('godot_scene_inspect', { path: 'world.tscn', view: 'properties', node: 'Player' })).toContain('"position":{"x":48,"y":32}')
    await test.ok('godot_node_edit', { path: 'world.tscn', node: 'Player', action: 'group_add', target: 'actors' })
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toContain('groups=["actors"]')
    await test.ok('godot_node_edit', { path: 'world.tscn', node: 'Player', action: 'duplicate', target: 'Copy' })
    expect(await test.ok('godot_scene_inspect', { path: 'world.tscn' })).toContain('"name":"Copy"')
    await test.ok('godot_node_edit', { path: 'world.tscn', node: 'Copy', action: 'rename', target: 'Renamed' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Actors', type: 'Node2D' })
    await test.ok('godot_node_edit', { path: 'world.tscn', node: 'Renamed', action: 'reparent', target: 'Actors' })
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toContain('parent="Actors/Renamed"')
    await test.ok('godot_node_edit', { path: 'world.tscn', node: 'Actors/Renamed', action: 'remove' })
    expect(await test.ok('godot_scene_inspect', { path: 'world.tscn' })).not.toContain('Renamed')
    await test.ok('godot_scene_create', { path: 'child.tscn', type: 'Node2D' })
    await test.ok('godot_node_add', { path: 'child.tscn', parent: 'root', name: 'Leaf', type: 'Node2D' })
    await test.ok('godot_scene_instance', { path: 'world.tscn', reference: 'child.tscn', parent: 'Actors', name: 'Nested' })
    expect(await test.ok('godot_scene_inspect', { path: 'world.tscn' })).toContain('"name":"Leaf"')
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'AnimationPlayer', type: 'AnimationPlayer' })
    await test.ok('godot_resource_create', { path: 'idle.tres', type: 'Animation' })
    await test.ok('godot_resource_set', { path: 'idle.tres', property: 'length', value: '2.0' })
    await test.ok('godot_animation_track', { path: 'idle.tres', node_property: 'Player:position' })
    await test.ok('godot_animation_key', { path: 'idle.tres', track: 0, time: 1.5, value: 'Vector2(60, 40)' })
    await test.ok('godot_animation_bind', { path: 'world.tscn', node: 'AnimationPlayer', name: 'idle', reference: 'idle.tres' })
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toContain('res://idle.tres')
    expect(await readFile(join(test.project, 'idle.tres'), 'utf8')).toContain('length = 2.0')
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Clock', type: 'Timer' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Target', type: 'Node' })
    await test.ok('godot_node_edit', { path: 'world.tscn', node: 'Clock', action: 'connect', target: 'Target', signal: 'timeout', method: 'queue_free' })
    const scene = await readFile(join(test.project, 'world.tscn'), 'utf8')
    expect(scene).toContain('[connection signal="timeout" from="Clock" to="Target" method="queue_free"]')
    await writeFile(join(test.project, 'world.tscn'), scene.replace('position = Vector2(48, 32)', 'position = Vector2(80, 90)'))
    expect(await test.ok('godot_scene_inspect', { path: 'world.tscn' })).toContain('80,90')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--editor')
    expect((await readdir(test.project)).filter(name => name.endsWith('.gd'))).toEqual([])
  } finally { spawn.mockRestore(); await test.cleanup() }
}, 20_000)

it.skipIf(!available)('ports Vollkorn atlas filling and single-cell TileMap editing while refusing invalid mutations', async () => {
  const test = await setup()
  try {
    await test.ok('godot_resource_create', { path: 'texture.tres', type: 'GradientTexture2D' })
    await test.ok('godot_tileset_create', { path: 'atlas.tres', reference: 'texture.tres', width: 16, height: 16 })
    await test.ok('godot_scene_create', { path: 'tiles.tscn', type: 'Node2D' })
    await test.ok('godot_node_add', { path: 'tiles.tscn', parent: 'root', name: 'Map', type: 'TileMapLayer' })
    await test.ok('godot_node_reference', { path: 'tiles.tscn', node: 'Map', property: 'tile_set', reference: 'atlas.tres' })
    await test.ok('godot_tile_cell', { path: 'tiles.tscn', node: 'Map', x: -2, y: 3, source: 0, atlas_x: 3, atlas_y: 3 })
    expect(await test.ok('godot_scene_inspect', { path: 'tiles.tscn', view: 'cells', node: 'Map' })).toContain('"cell_count":1')
    const before = await readFile(join(test.project, 'tiles.tscn'), 'utf8')
    for (const [name, args] of [
      ['godot_node_set', { path: 'tiles.tscn', node: 'Map', property: 'position', value: '"wrong"' }],
      ['godot_node_add', { path: 'tiles.tscn', parent: 'root', name: 'Map', type: 'Node2D' }],
      ['godot_node_edit', { path: 'tiles.tscn', node: 'root', action: 'remove' }],
      ['godot_node_edit', { path: 'tiles.tscn', node: 'Map', action: 'reparent', target: 'Map' }],
      ['godot_node_set', { path: 'tiles.tscn', node: 'Missing', property: 'position', value: '[1,2]' }],
      ['godot_tile_cell', { path: 'tiles.tscn', node: 'Map', x: 0, y: 0, source: 0, atlas_x: 99, atlas_y: 99 }],
    ] satisfies [string, Record<string, string | number>][]) {
      expect((await test.call(name, args)).isError).toBe(true)
      expect(await readFile(join(test.project, 'tiles.tscn'), 'utf8')).toBe(before)
    }
    await test.ok('godot_tile_cell', { path: 'tiles.tscn', node: 'Map', x: -2, y: 3, source: -1, atlas_x: 0, atlas_y: 0 })
    expect(await test.ok('godot_scene_inspect', { path: 'tiles.tscn', view: 'cells', node: 'Map' })).toContain('"cell_count":0')
    expect((await test.call('godot_resource_create', { path: 'invalid.tres', type: 'Node2D' })).isError).toBe(true)
    await expect(access(join(test.project, 'invalid.tres'))).rejects.toThrow()
  } finally { await test.cleanup() }
}, 20_000)

it('retains the pinned source mapping, unchanged conversion helpers and MIT notice', async () => {
  const { createHash } = await import('node:crypto')
  const resources = fileURLToPath(new URL('../../desktop/resources/godot/', import.meta.url))
  const manifest: unknown = JSON.parse(await readFile(join(resources, 'vollkorn-source.json'), 'utf8'))
  expect(manifest).toMatchObject({ repository: 'https://github.com/Vollkorn-Games/godot-mcp',
    commit: '632530638448ea3e79394fbf74e9a5c92c4b67e5', license: 'MIT', sourcePath: 'src/scripts/godot_operations.gd' })
  if (typeof manifest !== 'object' || manifest === null || !('functions' in manifest) || !Array.isArray(manifest.functions)) {
    throw new Error('Invalid source mapping')
  }
  const mappings: unknown[] = manifest.functions
  const source = await readFile(join(resources, 'vollkorn-edit.gd'), 'utf8')
  for (const name of ['_convert_property_value', '_get_property_type', '_serialize_value', '_set_owner_recursive', '_serialize_node']) {
    const mapping = mappings.find(row => typeof row === 'object' && row !== null && 'name' in row && row.name === name)
    if (typeof mapping !== 'object' || mapping === null || !('sha256' in mapping)) throw new Error('Missing source mapping')
    const start = source.indexOf(`func ${name}(`)
    const following = source.indexOf('\nfunc ', start + 1)
    const lines = source.slice(start, following < 0 ? undefined : following).trimEnd().split('\n')
    while (lines.length > 0 && (!lines.at(-1)?.trim() || !lines.at(-1)?.startsWith(' '))) lines.pop()
    expect(createHash('sha256').update(lines.join('\n') + '\n').digest('hex')).toBe(mapping.sha256)
  }
  const license = await readFile(join(resources, 'VOLLKORN_LICENSE.txt'), 'utf8')
  expect(license).toContain('Copyright (c) 2025 Solomon Elias')
  expect(license).toContain('MIT License')
})

it.skipIf(!available)('groups small native edits, rolls back failures and undoes a committed multi-file group', async () => {
  const test = await setup()
  try {
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node2D' })
    const before = await readFile(join(test.project, 'world.tscn'), 'utf8')
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Player', type: 'Node2D' })
    await test.ok('godot_resource_create', { path: 'shape.tres', type: 'RectangleShape2D' })
    await test.ok('godot_edit_transaction', { action: 'commit' })
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toContain('Player')
    await test.ok('godot_edit_transaction', { action: 'undo' })
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    await expect(access(join(test.project, 'shape.tres'))).rejects.toThrow()
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Player', type: 'Node2D' })
    const failed = await test.call('godot_node_set', { path: 'world.tscn', node: 'Player', property: 'position', value: '"invalid"' })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toContain('edit group rolled back')
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Player', type: 'Node2D' })
    await test.ok('godot_edit_transaction', { action: 'rollback' })
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Player', type: 'Node2D' })
    await test.call('godot_worker_stop')
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
  } finally { await test.cleanup() }
}, 20_000)

it.skipIf(!available)('refuses rollback and undo after external edits without overwriting user files', async () => {
  const test = await setup()
  try {
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node2D' })
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Player', type: 'Node2D' })
    await test.ok('godot_edit_transaction', { action: 'commit' })
    const external = (await readFile(join(test.project, 'world.tscn'), 'utf8')) + '\n; external change\n'
    await writeFile(join(test.project, 'world.tscn'), external)
    expect((await test.call('godot_edit_transaction', { action: 'undo' })).isError).toBe(true)
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(external)
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Other', type: 'Node2D' })
    const changed = (await readFile(join(test.project, 'world.tscn'), 'utf8')) + '\n; newer external change\n'
    await writeFile(join(test.project, 'world.tscn'), changed)
    expect((await test.call('godot_edit_transaction', { action: 'rollback' })).isError).toBe(true)
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(changed)
  } finally { await test.cleanup() }
}, 20_000)


it.skipIf(!available)('attaches valid scripts through native references and rejects incompatible or invalid scripts without saving', async () => {
  const test = await setup()
  try {
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node2D' })
    await writeFile(join(test.project, 'player.gd'), 'extends Node2D\n@export var speed: float = 100.0\n@export var options: Dictionary = {}\nfunc jump():\n\tpass\n')
    await test.ok('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'script', reference: 'player.gd' })
    expect(await test.ok('godot_scene_inspect', { path: 'world.tscn' })).toContain('res://player.gd')
    await test.ok('godot_node_set', { path: 'world.tscn', node: 'root', property: 'speed', value: '200.0' })
    expect(await test.ok('godot_scene_inspect', { path: 'world.tscn', view: 'properties', node: 'root' })).toContain('200')
    await test.ok('godot_node_set', { path: 'world.tscn', node: 'root', property: 'options', value: '{"x": "text", "y": 2}' })
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toContain('"x": "text"')
    const before = await readFile(join(test.project, 'world.tscn'), 'utf8')
    await writeFile(join(test.project, 'bad.gd'), 'extends Node3D\n')
    const mismatch = await test.call('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'script', reference: 'bad.gd' })
    expect(mismatch.isError).toBe(true)
    expect(JSON.stringify(mismatch.content)).toContain('node_class=Node2D, script_base=Node3D, can_instantiate=true')
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    await writeFile(join(test.project, 'bad.gd'), 'extends CharacterBody2D\nfunc _physics_process(_delta):\n\tvelocity = move_and_slide(velocity)\n')
    const invalid = await test.call('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'script', reference: 'bad.gd' })
    expect(invalid.isError).toBe(true)
    const diagnostic = JSON.stringify(invalid.content)
    expect(diagnostic).toContain('can_instantiate=false')
    expect(diagnostic).toContain('res://bad.gd:3')
    expect(diagnostic).toContain('Too many arguments')
    expect(diagnostic).toContain('godot-project check')
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    await writeFile(join(test.project, 'bad.gd'), 'extends Node2D\n')
    await test.ok('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'script', reference: 'bad.gd' })
  } finally { await test.cleanup() }
}, 15_000)


it.skipIf(!available)('rejects malformed vector inputs promptly and reuses the worker for model correction', async () => {
  const test = await setup()
  const spawn = vi.spyOn(test.ctx.subprocess, 'spawn')
  try {
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node2D' })
    const before = await readFile(join(test.project, 'world.tscn'), 'utf8')
    for (const value of ['["oops", 2]', '{"x": "oops", "y": 2}', '[null, 2]']) {
      const result = await test.call('godot_node_set', { path: 'world.tscn', node: 'root', property: 'position', value })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('components must be finite numbers')
      expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    }
    await test.ok('godot_node_set', { path: 'world.tscn', node: 'root', property: 'position', value: '[2, 3]' })
    expect(spawn).toHaveBeenCalledTimes(1)
  } finally { spawn.mockRestore(); await test.cleanup() }
}, 15_000)

it.skipIf(!available)('never follows a redirected symlink during transaction rollback', async () => {
  const test = await setup()
  try {
    await test.ok('godot_resource_create', { path: 'shape.tres', type: 'RectangleShape2D' })
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_resource_set', { path: 'shape.tres', property: 'size', value: '[20, 40]' })
    const saved = await readFile(join(test.project, 'shape.tres'), 'utf8')
    const outside = join(test.root, 'outside.tres')
    await writeFile(outside, saved)
    await rm(join(test.project, 'shape.tres'))
    await symlink(outside, join(test.project, 'shape.tres'))
    const result = await test.call('godot_edit_transaction', { action: 'rollback' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('without symlinks')
    expect(await readFile(outside, 'utf8')).toBe(saved)
  } finally { await test.cleanup() }
}, 15_000)


it.skipIf(!available)('identifies unknown property targets and gives precise inspection guidance', async () => {
  const test = await setup()
  try {
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node2D' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Player', type: 'CharacterBody2D' })
    const before = await readFile(join(test.project, 'world.tscn'), 'utf8')
    const nodeError = await test.call('godot_node_set', { path: 'world.tscn', node: 'Player', property: 'enabled_in_game_screen', value: 'true' })
    expect(nodeError.isError).toBe(true)
    const nodeDiagnostic = JSON.stringify(nodeError.content)
    for (const expected of ['enabled_in_game_screen', 'node=Player', 'node_class=CharacterBody2D', 'godot_scene_inspect', "view='properties'"]) expect(nodeDiagnostic).toContain(expected)
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    await test.ok('godot_resource_create', { path: 'shape.tres', type: 'RectangleShape2D' })
    const resourceError = await test.call('godot_resource_set', { path: 'shape.tres', property: 'imaginary', value: 'true' })
    expect(resourceError.isError).toBe(true)
    const resourceDiagnostic = JSON.stringify(resourceError.content)
    for (const expected of ['imaginary', 'RectangleShape2D', 'shape.tres', 'godot_resource_inspect']) expect(resourceDiagnostic).toContain(expected)
    expect(nodeDiagnostic.length).toBeLessThan(2000)
    expect(resourceDiagnostic.length).toBeLessThan(2000)
    await test.ok('godot_resource_set', { path: 'shape.tres', property: 'size', value: '[20, 40]' })
  } finally { await test.cleanup() }
}, 15_000)


it.skipIf(!available)('commits bounded batches and undoes the whole latest batch', async () => {
  const test = await setup()
  try {
    await writeFile(join(test.project, 'player.gd'), 'extends Node2D\n')
    const result = await test.ok('godot_edit_batch', { operations: [
      { operation: 'scene_create', path: 'batch.tscn', type: 'Node2D' },
      { operation: 'node_add', path: 'batch.tscn', parent: 'root', name: 'Player', type: 'Node2D' },
      { operation: 'node_set', path: 'batch.tscn', node: 'Player', property: 'position', value: '[12, 34]' },
      { operation: 'node_reference', path: 'batch.tscn', node: 'Player', property: 'script', reference: 'player.gd' },
      { operation: 'resource_create', path: 'shape.tres', type: 'RectangleShape2D' },
      { operation: 'resource_set', path: 'shape.tres', property: 'size', value: '[20, 40]' },
      { operation: 'node_add', path: 'batch.tscn', parent: 'Player', name: 'Shape', type: 'CollisionShape2D' },
      { operation: 'node_reference', path: 'batch.tscn', node: 'Player/Shape', property: 'shape', reference: 'shape.tres' },
      { operation: 'resource_create', path: 'gradient.tres', type: 'Gradient' },
      { operation: 'resource_create', path: 'texture.tres', type: 'GradientTexture2D' },
      { operation: 'resource_reference', path: 'texture.tres', property: 'gradient', reference: 'gradient.tres' },
    ] })
    expect(result).toContain('"status":"committed"')
    expect(result).toContain('"index":10')
    const tree = await test.ok('godot_scene_inspect', { path: 'batch.tscn' })
    expect(tree).toContain('"script":null')
    expect(tree).toContain('"script":"res://player.gd"')
    expect(await readFile(join(test.project, 'batch.tscn'), 'utf8')).toContain('Vector2(12, 34)')
    expect(await readFile(join(test.project, 'texture.tres'), 'utf8')).toContain('res://gradient.tres')
    await test.ok('godot_edit_transaction', { action: 'undo' })
    for (const file of ['batch.tscn', 'shape.tres', 'gradient.tres', 'texture.tres']) await expect(access(join(test.project, file))).rejects.toThrow()
    expect(await readFile(join(test.project, 'player.gd'), 'utf8')).toBe('extends Node2D\n')
  } finally { await test.cleanup() }
}, 20_000)

it.skipIf(!available)('rolls back a failed middle batch step and preserves the previous undo group', async () => {
  const test = await setup()
  try {
    await test.ok('godot_edit_batch', { operations: [{ operation: 'scene_create', path: 'batch.tscn', type: 'Node2D' }] })
    const before = await readFile(join(test.project, 'batch.tscn'), 'utf8')
    const result = await test.call('godot_edit_batch', { operations: [
      { operation: 'node_set', path: 'batch.tscn', node: 'root', property: 'position', value: '[10, 20]' },
      { operation: 'resource_create', path: 'temporary.tres', type: 'Curve' },
      { operation: 'node_set', path: 'batch.tscn', node: 'root', property: 'nonexistent', value: 'true' },
      { operation: 'resource_create', path: 'unreached.tres', type: 'Curve' },
    ] })
    expect(result.isError).toBe(true)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('"failed_index":2')
    expect(text).toContain('"rollback":"completed"')
    expect(text).toContain('"status":"not_run"')
    expect(await readFile(join(test.project, 'batch.tscn'), 'utf8')).toBe(before)
    for (const file of ['temporary.tres', 'unreached.tres']) await expect(access(join(test.project, file))).rejects.toThrow()
    await test.ok('godot_edit_transaction', { action: 'undo' })
    await expect(access(join(test.project, 'batch.tscn'))).rejects.toThrow()
  } finally { await test.cleanup() }
}, 15_000)

it.skipIf(!available)('validates all batch input before writing and refuses an existing transaction without changing it', async () => {
  const test = await setup()
  try {
    const first = { operation: 'resource_create', path: 'not-created.tres', type: 'Curve' }
    for (const operations of [[], Array.from({ length: 17 }, () => first), [first, { operation: 'node_set', path: 'scene.tscn', node: 'root', property: 'position' }],
      [first, { operation: 'resource_create', path: '../escape.tres', type: 'Curve' }],
      [first, { operation: 'resource_set', path: 'shape.tres', property: 'resource_name', value: 'x'.repeat(33000) }],
      [first, { operation: 'transaction', action: 'begin' }], [first, { ...first, command: 'shell' }],
      [first, { operation: 'resource_create', path: 'wrong.tscn', type: 'Curve' }],
    ]) {
      expect((await test.call('godot_edit_batch', { operations })).isError).toBe(true)
      await expect(access(join(test.project, 'not-created.tres'))).rejects.toThrow()
    }
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_resource_create', { path: 'existing.tres', type: 'Curve' })
    const refused = await test.call('godot_edit_batch', { operations: [first] })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('already open')
    await access(join(test.project, 'existing.tres'))
    await test.ok('godot_edit_transaction', { action: 'rollback' })
    await expect(access(join(test.project, 'existing.tres'))).rejects.toThrow()
  } finally { await test.cleanup() }
}, 15_000)


it.skipIf(!available)('accepts named script resource classes and subclasses without accepting unrelated resources', async () => {
  const test = await setup()
  try {
    await writeFile(join(test.project, 'weapon.gd'), 'class_name WeaponData\nextends Resource\n@export var damage: int = 10\n')
    await writeFile(join(test.project, 'heavy.gd'), 'class_name HeavyWeaponData\nextends WeaponData\n')
    await writeFile(join(test.project, 'loadout.gd'), 'class_name LoadoutData\nextends Resource\n@export var weapon: WeaponData\n')
    await writeFile(join(test.project, 'player.gd'), 'extends Node3D\n@export var weapon: WeaponData\n')
    for (const name of ['weapon', 'heavy', 'loadout']) {
      await writeFile(join(test.project, `${name}.tres`), `[gd_resource type="Resource" load_steps=2 format=3]\n[ext_resource type="Script" path="res://${name}.gd" id="1"]\n[resource]\nscript = ExtResource("1")\n`)
    }
    const { spawnSync } = await import('node:child_process')
    const imported = spawnSync(join(engine, 'Contents/MacOS/Godot'), ['--headless', '--editor', '--path', test.project, '--import'], { encoding: 'utf8', timeout: 15_000 })
    expect(imported.status, imported.stderr).toBe(0)
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node3D' })
    await test.ok('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'script', reference: 'player.gd' })
    for (const reference of ['weapon.tres', 'heavy.tres']) {
      await test.ok('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'weapon', reference })
      expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toContain(`res://${reference}`)
      await test.ok('godot_resource_reference', { path: 'loadout.tres', property: 'weapon', reference })
      expect(await readFile(join(test.project, 'loadout.tres'), 'utf8')).toContain(`res://${reference}`)
    }
    await test.ok('godot_resource_create', { path: 'wrong.tres', type: 'StandardMaterial3D' })
    const sceneBefore = await readFile(join(test.project, 'world.tscn'), 'utf8')
    const loadoutBefore = await readFile(join(test.project, 'loadout.tres'), 'utf8')
    for (const reference of ['wrong.tres', 'missing.tres', '../escape.tres']) {
      expect((await test.call('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'weapon', reference })).isError).toBe(true)
      expect((await test.call('godot_resource_reference', { path: 'loadout.tres', property: 'weapon', reference })).isError).toBe(true)
      expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(sceneBefore)
      expect(await readFile(join(test.project, 'loadout.tres'), 'utf8')).toBe(loadoutBefore)
    }
    await writeFile(join(test.project, 'broken.gd'), 'class_name BrokenWeapon\nextends WeaponData\nfunc broken(:\n')
    await writeFile(join(test.project, 'broken.tres'), '[gd_resource type="Resource" load_steps=2 format=3]\n[ext_resource type="Script" path="res://broken.gd" id="1"]\n[resource]\nscript = ExtResource("1")\n')
    expect((await test.call('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'weapon', reference: 'broken.tres' })).isError).toBe(true)
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(sceneBefore)
  } finally { await test.cleanup() }
}, 25_000)


it.skipIf(!available)('guides literal versus resource-path correction and distinguishes missing from unloadable files', async () => {
  const test = await setup()
  try {
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Sprite2D' })
    await test.ok('godot_resource_create', { path: 'texture.tres', type: 'GradientTexture2D' })
    await test.ok('godot_resource_create', { path: 'gradient.tres', type: 'Gradient' })
    const sceneBefore = await readFile(join(test.project, 'world.tscn'), 'utf8')
    const textureBefore = await readFile(join(test.project, 'texture.tres'), 'utf8')
    for (const [tool, args, referenceTool] of [
      ['godot_node_set', { path: 'world.tscn', node: 'root', property: 'texture', value: 'res://texture.tres' }, 'godot_node_reference'],
      ['godot_resource_set', { path: 'texture.tres', property: 'gradient', value: 'res://gradient.tres' }, 'godot_resource_reference'],
    ] satisfies [string, Record<string, string>, string][]) {
      const invalid = await test.call(tool, args)
      expect(invalid.isError).toBe(true)
      const diagnostic = JSON.stringify(invalid.content)
      expect(diagnostic).toContain('double quotes')
      expect(diagnostic).toContain(referenceTool)
      expect(diagnostic).toContain('reference=')
      const quoted = await test.call(tool, { ...args, value: JSON.stringify(args.value) })
      expect(quoted.isError).toBe(true)
      expect(JSON.stringify(quoted.content)).toContain(referenceTool)
    }
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(sceneBefore)
    expect(await readFile(join(test.project, 'texture.tres'), 'utf8')).toBe(textureBefore)
    await writeFile(join(test.project, 'broken.tres'), 'not a Godot resource')
    for (const [reference, expected] of [['missing.tres', 'does not exist'], ['broken.tres', 'exists but Godot could not load']] as const) {
      for (const [tool, args] of [
        ['godot_node_reference', { path: 'world.tscn', node: 'root', property: 'texture', reference }],
        ['godot_resource_reference', { path: 'texture.tres', property: 'gradient', reference }],
      ] satisfies [string, Record<string, string>][]) {
        const result = await test.call(tool, args)
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain(expected)
        if (reference === 'broken.tres') expect(JSON.stringify(result.content)).toContain('godot-project check')
      }
    }
    await test.ok('godot_resource_set', { path: 'gradient.tres', property: 'resource_name', value: '"named gradient"' })
    await test.ok('godot_resource_reference', { path: 'texture.tres', property: 'gradient', reference: 'gradient.tres' })
    await test.ok('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'texture', reference: 'texture.tres' })
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toContain('res://texture.tres')
  } finally { await test.cleanup() }
}, 15_000)


it.skipIf(!available)('validates the bundled InputMap example with the real engine and keeps built-in controls available', async () => {
  const test = await setup()
  try {
    const skill = await test.ctx.skills.get('godot-game-development')
    const example = skill?.content.match(/```ini\n(\[input\][\s\S]*?)\n```/u)?.[1]
    expect(example).toBeDefined()
    await writeFile(join(test.project, 'project.godot'), `config_version=5\n[application]\nconfig/name="InputMapExample"\n${example}\n`)
    await writeFile(join(test.project, 'verify_input.gd'), [
      'extends SceneTree', 'func _initialize():',
      '\tfor action in ["ui_left", "ui_right", "ui_accept"]:',
      '\t\tassert(InputMap.has_action(action))', '\t\tassert(InputMap.action_get_events(action).size() > 0)',
      '\tvar events = InputMap.action_get_events("move_left")', '\tassert(events.size() == 1)',
      '\tassert(events[0] is InputEventKey)', '\tassert(events[0].physical_keycode == KEY_A)',
      '\tvar pressed = InputEventKey.new()', '\tpressed.physical_keycode = KEY_A', '\tpressed.pressed = true',
      '\tassert(InputMap.event_is_action(pressed, "move_left"))', '\tprint("INPUTMAP_EXAMPLE_PASS")', '\tquit()', '',
    ].join('\n'))
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(join(engine, 'Contents/MacOS/Godot'), ['--headless', '--path', test.project, '--script', 'res://verify_input.gd'], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('INPUTMAP_EXAMPLE_PASS')
    expect(result.stderr).not.toMatch(/SCRIPT ERROR:|ERROR:/u)
  } finally { await test.cleanup() }
}, 15_000)

it.skipIf(!available)('rejects incompatible signal arity and saves working default/variadic connections visible in the tree', async () => {
  const test = await setup()
  try {
    await writeFile(join(test.project, 'signals.gd'), [
      'extends Node', 'signal one(value)', 'signal pair(first, second)', 'var calls: Array[String] = []',
      'func required(value):', '\tpass', 'func no_args():', '\tcalls.append("none")',
      'func default_arg(value = 5):', '\tcalls.append("default:" + str(value))',
      'func variadic(...values: Array):', '\tcalls.append("var:" + str(values.size()))',
      'func required_variadic(first, ...values: Array):', '\tcalls.append("reqvar:" + str(values.size()))', '',
    ].join('\n'))
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node' })
    await test.ok('godot_node_reference', { path: 'world.tscn', node: 'root', property: 'script', reference: 'signals.gd' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Button', type: 'Button' })
    const before = await readFile(join(test.project, 'world.tscn'), 'utf8')
    for (const [node, signal, method] of [
      ['Button', 'pressed', 'required'], ['root', 'pair', 'required'],
      ['root', 'one', 'no_args'], ['Button', 'pressed', 'required_variadic'],
    ] as const) {
      const result = await test.call('godot_node_edit', { path: 'world.tscn', node, action: 'connect', target: 'root', signal, method })
      expect(result.isError).toBe(true)
      const text = JSON.stringify(result.content)
      expect(text).toContain(`Signal '${signal}' emits`)
      expect(text).toContain(`method '${method}' accepts`)
      expect(text).toContain('No connection saved')
      expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    }
    expect(await test.ok('godot_scene_inspect', { path: 'world.tscn' })).toContain('"saved_connections":[]')
    for (const [node, signal, method] of [
      ['Button', 'pressed', 'default_arg'], ['Button', 'pressed', 'no_args'],
      ['root', 'one', 'variadic'], ['root', 'pair', 'required_variadic'],
    ] as const) await test.ok('godot_node_edit', { path: 'world.tscn', node, action: 'connect', target: 'root', signal, method })
    const tree = await test.ok('godot_scene_inspect', { path: 'world.tscn' })
    expect(tree).toContain('"source":"Button"')
    expect(tree).toContain('"target":"."')
    expect(tree).toContain('"method":"required_variadic"')
    expect(tree).toContain('"saved_connections_truncated":false')
    await writeFile(join(test.project, 'emit.gd'), [
      'extends SceneTree', 'func _initialize():', '\tvar main = load("res://world.tscn").instantiate()',
      '\tmain.get_node("Button").pressed.emit()', '\tmain.one.emit(3)', '\tmain.pair.emit(1, 2)',
      '\tassert(main.calls == ["default:5", "none", "var:1", "reqvar:1"])',
      '\tmain.free()', '\tprint("SIGNALS_PASS")', '\tquit()', '',
    ].join('\n'))
    const { spawnSync } = await import('node:child_process')
    const emitted = spawnSync(join(engine, 'Contents/MacOS/Godot'), ['--headless', '--path', test.project, '--script', 'res://emit.gd'], { encoding: 'utf8', timeout: 10_000 })
    expect(emitted.status, emitted.stderr).toBe(0)
    expect(emitted.stdout).toContain('SIGNALS_PASS')
    expect(emitted.stderr).not.toMatch(/SCRIPT ERROR:|ERROR:/u)
  } finally { await test.cleanup() }
}, 20_000)

for (const phase of ['executing', 'prepared', 'committed'] as const) {
  it.skipIf(!available)(`drains a real batch cancelled while ${phase} without undoing an unrelated group`, async () => {
    const test = await setup()
    const abort = new AbortController()
    const original = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
    let armed = false
    const spawn = vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = original(spec)
      handle.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        if (armed && phase !== 'executing' && text.includes(phase === 'prepared' ? '"status":"prepared"' : '"transaction":"committed"')) abort.abort()
      })
      return handle
    })
    try {
      await test.ok('godot_edit_batch', { operations: [{ operation: 'resource_create', path: 'previous.tres', type: 'Curve' }] })
      await writeFile(join(test.project, 'slow.gd'), 'extends Curve\nfunc _init():\n\tvar file = FileAccess.open("res://started.txt", FileAccess.WRITE)\n\tfile.store_string("started")\n\tfile.close()\n\tOS.delay_msec(400)\n')
      const source = '[gd_resource type="Curve" load_steps=2 format=3]\n[ext_resource type="Script" path="res://slow.gd" id="1"]\n[resource]\nscript = ExtResource("1")\n'
      await writeFile(join(test.project, 'slow.tres'), source)
      armed = true
      const pending = test.call('godot_edit_batch', { operations: [
        { operation: 'resource_create', path: 'fresh.tres', type: 'Curve' },
        { operation: 'resource_set', path: 'slow.tres', property: 'bake_resolution', value: '25' },
      ] }, abort.signal)
      if (phase === 'executing') {
        await vi.waitFor(async () => { await access(join(test.project, 'started.txt')) }, { timeout: 3000 })
        abort.abort()
      }
      const result = await pending
      expect(result.isError).toBe(true)
      const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      if (phase === 'committed') {
        expect(text).toContain('Batch committed; cancellation arrived after commit')
        await access(join(test.project, 'fresh.tres'))
      } else {
        expect(text).toContain('"rollback":"completed"')
        await expect(access(join(test.project, 'fresh.tres'))).rejects.toThrow()
        expect(await readFile(join(test.project, 'slow.tres'), 'utf8')).toBe(source)
      }
      await test.ok('godot_edit_transaction', { action: 'undo' })
      if (phase === 'committed') {
        await access(join(test.project, 'previous.tres'))
        await expect(access(join(test.project, 'fresh.tres'))).rejects.toThrow()
      } else await expect(access(join(test.project, 'previous.tres'))).rejects.toThrow()
    } finally { spawn.mockRestore(); await test.cleanup() }
  }, 15_000)
}

it.skipIf(!available)('bounds batch cancellation cleanup when a resource constructor hangs and reports unknown rollback', async () => {
  const test = await setup()
  const abort = new AbortController()
  try {
    await writeFile(join(test.project, 'slow.gd'), 'extends Curve\nfunc _init():\n\tvar file = FileAccess.open("res://started.txt", FileAccess.WRITE)\n\tfile.store_string("started")\n\tfile.close()\n\tOS.delay_msec(10000)\n')
    await writeFile(join(test.project, 'slow.tres'), '[gd_resource type="Curve" load_steps=2 format=3]\n[ext_resource type="Script" path="res://slow.gd" id="1"]\n[resource]\nscript = ExtResource("1")\n')
    const pending = test.call('godot_edit_batch', { operations: [
      { operation: 'resource_create', path: 'fresh.tres', type: 'Curve' },
      { operation: 'resource_set', path: 'slow.tres', property: 'bake_resolution', value: '25' },
    ] }, abort.signal)
    await vi.waitFor(async () => { await access(join(test.project, 'started.txt')) }, { timeout: 3000 })
    abort.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('rollback unknown')
    await access(join(test.project, 'fresh.tres'))
    await test.ok('godot_resource_create', { path: 'recovered.tres', type: 'Curve' })
  } finally { await test.cleanup() }
}, 15_000)


it.skipIf(!available)('reports bounded current-request parser diagnostics for native scene and resource load failures', async () => {
  const test = await setup()
  try {
    await writeFile(join(test.project, 'missing-dependency.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://missing-picture.tscn" id="1"]\n[node name="Root" instance=ExtResource("1")]\n')
    const missing = await test.call('godot_node_add', { path: 'missing-dependency.tscn', parent: 'root', name: 'Child', type: 'Node' })
    expect(missing.isError).toBe(true)
    const missingText = JSON.stringify(missing.content)
    expect(missingText).toContain('missing-picture.tscn')
    expect(missingText).toContain('godot-project check')
    expect(missingText.length).toBeLessThan(16000)
    await writeFile(join(test.project, 'bad-scene.tscn'), '[gd_scene format=3]\n[node name="Root" type="Node2D"]\nposition = Vector2(\n')
    const badScene = await test.call('godot_node_add', { path: 'bad-scene.tscn', parent: 'root', name: 'Child', type: 'Node' })
    const sceneText = JSON.stringify(badScene.content)
    expect(badScene.isError).toBe(true)
    expect(sceneText).toContain('bad-scene.tscn:')
    expect(sceneText).toContain('Parse Error')
    expect(sceneText).not.toContain('missing-picture.tscn')
    await writeFile(join(test.project, 'bad-resource.tres'), '[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius = CircleShape2D.new()\n')
    const badResource = await test.call('godot_resource_inspect', { path: 'bad-resource.tres' })
    const resourceText = JSON.stringify(badResource.content)
    expect(badResource.isError).toBe(true)
    expect(resourceText).toContain('bad-resource.tres:3')
    expect(resourceText).toContain('Unexpected identifier')
    expect(resourceText).not.toContain('bad-scene.tscn')
    await test.ok('godot_scene_create', { path: 'valid.tscn', type: 'Node2D' })
    const unrelated = await test.call('godot_node_add', { path: 'valid.tscn', parent: 'MissingParent', name: 'Child', type: 'Node' })
    expect(unrelated.isError).toBe(true)
    expect(JSON.stringify(unrelated.content)).not.toContain('bad-resource')
  } finally { await test.cleanup() }
}, 15000)



it.skipIf(!available)('preserves missing dependency references and rolls back a batch before native edits can erase them', async () => {
  const test = await setup()
  try {
    for (const [type, extension, nodeType, property] of [['Texture2D', 'png', 'Sprite2D', 'texture'], ['Material', 'tres', 'Sprite2D', 'material']]) {
      const original = `[gd_scene load_steps=2 format=3]\n[ext_resource type="${type}" path="res://missing-dependency.${extension}" id="1"]\n[node name="Root" type="${nodeType}"]\n${property} = ExtResource("1")\n`
      await writeFile(join(test.project, 'dependency.tscn'), original)
      const result = await test.call('godot_node_add', { path:'dependency.tscn',parent:'root',name:'Child',type:'Node' })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain(`missing-dependency.${extension}`)
      expect(JSON.stringify(result.content)).toContain('original references are preserved')
      expect(await readFile(join(test.project,'dependency.tscn'),'utf8')).toBe(original)
    }
    await test.ok('godot_scene_create', { path:'valid.tscn',type:'Node2D' })
    const valid = await readFile(join(test.project,'valid.tscn'),'utf8')
    const failedBatch = await test.call('godot_edit_batch', { operations:[
      { operation:'node_add',path:'valid.tscn',parent:'root',name:'First',type:'Node' },
      { operation:'node_add',path:'dependency.tscn',parent:'root',name:'Second',type:'Node' },
    ] })
    expect(failedBatch.isError).toBe(true)
    expect(await readFile(join(test.project,'valid.tscn'),'utf8')).toBe(valid)
    await writeFile(join(test.project, 'warning.gd'), 'extends Node2D\nfunc _init():\n\tpush_warning("fixture harmless warning")\n')
    await test.ok('godot_node_reference', { path:'valid.tscn',node:'root',property:'script',reference:'warning.gd' })
    await test.ok('godot_node_add', { path:'valid.tscn',parent:'root',name:'Safe',type:'Node' })
  } finally {await test.cleanup()}
},15000)


it.skipIf(!available)('refuses partially loaded secondary resource references before saving resources or animations', async () => {
  const test = await setup()
  try {
    await writeFile(join(test.project, 'partial.tres'), '[gd_resource type="AtlasTexture" load_steps=2 format=3]\n[ext_resource type="Texture2D" path="res://absent.png" id="1"]\n[resource]\natlas = ExtResource("1")\n')
    await test.ok('godot_resource_create', { path: 'style.tres', type: 'StyleBoxTexture' })
    await test.ok('godot_resource_create', { path: 'theme.tres', type: 'Theme' })
    await test.ok('godot_scene_create', { path: 'animation.tscn', type: 'AnimationPlayer' })
    await writeFile(join(test.project, 'partial-animation.tres'), '[gd_resource type="Animation" load_steps=2 format=3]\n[ext_resource type="Texture2D" path="res://absent.png" id="1"]\n[resource]\nmetadata/dependency = ExtResource("1")\n')
    for (const [tool, args] of [
      ['godot_resource_reference', { path: 'style.tres', property: 'texture', reference: 'partial.tres' }],
      ['godot_theme_item', { path: 'theme.tres', control: 'Button', item: 'icon', kind: 'icon', reference: 'partial.tres' }],
      ['godot_animation_bind', { path: 'animation.tscn', node: 'root', name: 'idle', reference: 'partial-animation.tres' }],
    ] as const) {
      const before = await readFile(join(test.project, args.path), 'utf8')
      const result = await test.call(tool, args)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('absent.png')
      expect(await readFile(join(test.project, args.path), 'utf8')).toBe(before)
    }
  } finally { await test.cleanup() }
}, 15000)

it.skipIf(!available)('refreshes changed autoload and imported global class registrations without unnecessary restarts', async () => {
  const test = await setup()
  const spawn = vi.spyOn(test.ctx.subprocess, 'spawn')
  try {
    await test.ok('godot_scene_create', { path: 'registry.tscn', type: 'Node2D' })
    await test.ok('godot_scene_inspect', { path: 'registry.tscn' })
    expect(spawn).toHaveBeenCalledTimes(1)
    await writeFile(join(test.project, 'manager.gd'), 'extends Node\nvar score = 1\n')
    await writeFile(join(test.project, 'project.godot'), await readFile(join(test.project, 'project.godot'), 'utf8')
      + '\n[autoload]\nGameManager="*res://manager.gd"\n')
    await writeFile(join(test.project, 'user.gd'), 'extends Node2D\nfunc score():\n\treturn GameManager.score\n')
    expect(await test.ok('godot_node_reference', { path: 'registry.tscn', node: 'root', property: 'script', reference: 'user.gd' })).toContain('worker_refresh')
    expect(spawn).toHaveBeenCalledTimes(2)
    await test.ok('godot_scene_inspect', { path: 'registry.tscn' })
    expect(spawn).toHaveBeenCalledTimes(2)
    await writeFile(join(test.project, 'global.gd'), 'class_name RefreshGlobal\nextends Resource\n')
    const { spawnSync } = await import('node:child_process')
    const imported = spawnSync(join(engine, 'Contents/MacOS/Godot'), ['--headless', '--editor', '--path', test.project, '--import'],
      { encoding: 'utf8', timeout: 15_000 })
    expect(imported.status, imported.stderr).toBe(0)
    await writeFile(join(test.project, 'user.gd'), 'extends Node2D\nvar item: RefreshGlobal\n')
    expect(await test.ok('godot_node_reference', { path: 'registry.tscn', node: 'root', property: 'script', reference: 'user.gd' })).toContain('worker_refresh')
    expect(spawn).toHaveBeenCalledTimes(3)
  } finally { await test.cleanup() }
})

it.skipIf(!available)('preserves active groups and undo while registration changes require refresh', async () => {
  const test = await setup()
  const spawn = vi.spyOn(test.ctx.subprocess, 'spawn')
  try {
    await test.ok('godot_scene_create', { path: 'registry.tscn', type: 'Node2D' })
    const original = await readFile(join(test.project, 'registry.tscn'), 'utf8')
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'registry.tscn', parent: 'root', name: 'Added', type: 'Node2D' })
    await writeFile(join(test.project, 'project.godot'), await readFile(join(test.project, 'project.godot'), 'utf8') + '\n; registry changed\n')
    const blocked = await test.call('godot_scene_inspect', { path: 'registry.tscn' })
    expect(blocked.isError).toBe(true)
    expect(JSON.stringify(blocked.content)).toContain('transaction_active=true')
    expect(spawn).toHaveBeenCalledTimes(1)
    await test.ok('godot_edit_transaction', { action: 'commit' })
    expect(JSON.stringify((await test.call('godot_scene_inspect', { path: 'registry.tscn' })).content)).toContain('has_undo=true')
    await test.ok('godot_edit_transaction', { action: 'undo' })
    expect(await readFile(join(test.project, 'registry.tscn'), 'utf8')).toBe(original)
    expect(await test.ok('godot_scene_inspect', { path: 'registry.tscn' })).toContain('worker_refresh')
    expect(spawn).toHaveBeenCalledTimes(2)
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'registry.tscn', parent: 'root', name: 'Again', type: 'Node2D' })
    await writeFile(join(test.project, 'project.godot'), await readFile(join(test.project, 'project.godot'), 'utf8') + '; again\n')
    await test.ok('godot_edit_transaction', { action: 'rollback' })
    expect(await readFile(join(test.project, 'registry.tscn'), 'utf8')).toBe(original)
    await test.ok('godot_scene_inspect', { path: 'registry.tscn' })
    await test.ok('godot_edit_transaction', { action: 'begin' })
    await test.ok('godot_node_add', { path: 'registry.tscn', parent: 'root', name: 'Committed', type: 'Node2D' })
    await test.ok('godot_edit_transaction', { action: 'commit' })
    await writeFile(join(test.project, 'project.godot'), await readFile(join(test.project, 'project.godot'), 'utf8') + '; stop\n')
    await test.call('godot_worker_stop')
    await test.ok('godot_scene_inspect', { path: 'registry.tscn' })
    expect((await test.call('godot_edit_transaction', { action: 'undo' })).isError).toBe(true)
  } finally { await test.cleanup() }
})

it.skipIf(!available)('executes the documented Player script and collision shape reference examples', async () => {
  const test = await setup()
  try {
    await test.ok('godot_scene_create', { path: 'res://Main.tscn', type: 'Node2D' })
    await test.ok('godot_node_add', { path: 'res://Main.tscn', parent: 'root', name: 'Player', type: 'CharacterBody2D' })
    await test.ok('godot_node_add', {
      path: 'res://Main.tscn', parent: 'Player', name: 'CollisionShape2D', type: 'CollisionShape2D',
    })
    await writeFile(join(test.project, 'Player.gd'), 'extends CharacterBody2D\n')
    await test.ok('godot_node_reference', {
      path: 'res://Main.tscn', node: 'Player', property: 'script', reference: 'res://Player.gd',
    })
    await test.ok('godot_resource_create', { path: 'res://Shape.tres', type: 'CircleShape2D' })
    await test.ok('godot_resource_set', { path: 'res://Shape.tres', property: 'radius', value: '8' })
    await test.ok('godot_node_reference', {
      path: 'res://Main.tscn', node: 'Player/CollisionShape2D', property: 'shape', reference: 'res://Shape.tres',
    })
    const tree = await test.ok('godot_scene_inspect', { path: 'res://Main.tscn' })
    expect(tree).toContain('"script":"res://Player.gd"')
    expect(tree).toContain('"type":"CharacterBody2D"')
    const scene = await readFile(join(test.project, 'Main.tscn'), 'utf8')
    expect(scene).toContain('path="res://Player.gd"')
    expect(scene).toContain('path="res://Shape.tres"')
    expect(scene).toContain('script = ExtResource(')
    expect(scene).toContain('shape = ExtResource(')
    const shape = await readFile(join(test.project, 'Shape.tres'), 'utf8')
    expect(shape).toContain('type="CircleShape2D"')
    expect(shape).toContain('radius = 8.0')
  } finally { await test.cleanup() }
})


it.skipIf(!available)('explains object references without losing batch rollback diagnostics', async () => {
  const test = await setup()
  try {
    await test.ok('godot_scene_create', { path: 'world.tscn', type: 'Node2D' })
    await test.ok('godot_node_add', { path: 'world.tscn', parent: 'root', name: 'Shape', type: 'CollisionShape2D' })
    const before = await readFile(join(test.project, 'world.tscn'), 'utf8')
    const result = await test.call('godot_edit_batch', { operations: [
      { operation: 'node_set', path: 'world.tscn', node: 'root', property: 'position', value: 'Vector2(12, 34)' },
      { operation: 'node_set', path: 'world.tscn', node: 'Shape', property: 'shape', value: '{"path":"res://shape.tres"}' },
    ] })
    expect(result.isError).toBe(true)
    const failure = JSON.stringify(result.content)
    for (const text of ['Node property requires Object Shape2D', 'godot_node_reference', 'failed_index', 'rollback', 'completed']) expect(failure).toContain(text)
    expect(await readFile(join(test.project, 'world.tscn'), 'utf8')).toBe(before)
    await test.ok('godot_resource_create', { path: 'texture.tres', type: 'GradientTexture2D' })
    const resourceResult = await test.call('godot_resource_set', { path: 'texture.tres', property: 'gradient', value: '{}' })
    expect(resourceResult.isError).toBe(true)
    const resourceFailure = JSON.stringify(resourceResult.content)
    expect(resourceFailure).toContain('Property requires Object Gradient')
    expect(resourceFailure).toContain('godot_resource_reference')
    await test.ok('godot_resource_create', { path: 'shape.tres', type: 'CircleShape2D' })
    await test.ok('godot_node_reference', { path: 'world.tscn', node: 'Shape', property: 'shape', reference: 'shape.tres' })
  } finally { await test.cleanup() }
}, 15_000)
