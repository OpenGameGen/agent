/** Small native Godot resource tools; scene/script text remains with the file tools. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { createGodotWorker } from './godot-worker.ts'
import type { GodotBatchEdit, WorkerConfig } from './godot-worker.ts'

/**
 * Register product resource operations directly in the Harness tool registry.
 * @param ctx - Product plugin scope.
 * @param runtime - Managed CLI and application resource paths.
 * @param config - Explicit worker limits.
 */
export function registerGodotTools(
  ctx: Context, runtime: { root: string; resources: string; node: string; python: string }, config: WorkerConfig,
): void {
  const worker = createGodotWorker(ctx, runtime, config)
  const project = { type: 'string', required: true, description: 'Absolute directory containing project.godot.' } as const
  const path = { type: 'string', required: true, description: 'Project-relative .tres path, e.g. materials/player.tres. Parent directory must exist.' } as const
  const subresource = { type: 'string', description: 'Optional colon-separated resource property chain, e.g. gradient or material:next_pass. Inspect first. Empty means the root resource.' } as const
  const value = { type: 'string', required: true, description: 'One Godot literal: 1.5, true, "text", Vector2(1, 2), Color(1, 0, 0, 1). Quote strings. For asset paths use the matching *_reference tool, not value. No code or batch JSON.' } as const
  const reference = { type: 'string', required: true, description: 'Existing project-relative resource or imported asset path.' } as const
  const output = { schema: { type: 'string' }, render: (_args: object, result: string) => [{ type: 'text' as const, text: result }] } as const
  const presentCall = () => ({ card: 'generic' as const, title: 'Edit Godot resource', kind: 'edit' as const })
  async function run(operation: string, args: Readonly<Record<string, string | number | undefined>>, exec: ToolExecution): Promise<string> {
    const normalized: Record<string, string | number> = {}
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || key === 'project') continue
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Use finite numbers')
      if (['track', 'source', 'x', 'y'].includes(key) && ['animation_key', 'tile_atlas', 'tile_create'].includes(operation) && typeof value === 'number' && value < 0) throw new Error('Indices must be nonnegative')
      if (['width', 'height'].includes(key) && typeof value === 'number' && value < 1) throw new Error('Tile dimensions must be positive')
      normalized[key] = value
    }
    if (typeof args.project !== 'string') throw new Error('Specify a project')
    return worker.request(args.project, operation, normalized, exec)
  }
  ctx.tools.register(defineTool({ name: 'godot_resource_create',
    description: 'Create one native Godot resource without overwriting an existing file. Use file tools for project.godot and .gd; use scene/node tools for .tscn. Call load_godot_runtime first. No GUI or project plugin.',
    parameters: { project, path, type: { type: 'string', required: true, description: 'Instantiable built-in Resource class, e.g. StandardMaterial3D, Theme, Curve, Gradient, Animation, TileSet or RectangleShape2D.' } },
    output, presentCall, execute: (args, exec) => run('create', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_resource_inspect',
    description: 'Read native resource properties, types and current values from disk, including animation track indices and TileSet source ids. No retained resource cache; inspect before changing a property.',
    parameters: { project, path, subresource }, output,
    presentCall: () => ({ card: 'generic', title: 'Inspect Godot resource', kind: 'read' }),
    execute: (args, exec) => run('inspect', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_resource_set',
    description: 'Set and save ONE stored resource property using a Godot literal. Engine validates the property type. Use godot_resource_reference for resource links. No objects or large JSON edits.',
    parameters: { project, path, subresource, property: { type: 'string', required: true }, value }, output, presentCall,
    execute: (args, exec) => run('set', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_resource_reference',
    description: 'Assign one resource property to an existing native resource or imported texture. Engine checks reference class. Reloads dependencies from disk.',
    parameters: { project, path, subresource, property: { type: 'string', required: true }, reference }, output, presentCall,
    execute: (args, exec) => run('reference', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_curve_point', description: 'Add one point to a Curve. x/y must fit its domain/value range; inspect and set those properties first if needed.',
    parameters: { project, path, subresource, x: { type: 'number', required: true }, y: { type: 'number', required: true } }, output, presentCall,
    execute: (args, exec) => run('curve_point', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_gradient_point', description: 'Add one Gradient color point. offset is 0..1; color is HTML hex such as #ff8800ff.',
    parameters: { project, path, subresource, offset: { type: 'number', required: true }, color: { type: 'string', required: true } }, output, presentCall,
    execute: (args, exec) => run('gradient_point', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_animation_track', description: 'Add one value track to an Animation and return its index. node_property is a Godot NodePath such as Player:position.',
    parameters: { project, path, subresource, node_property: { type: 'string', required: true } }, output, presentCall,
    execute: (args, exec) => run('animation_track', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_animation_key', description: 'Insert one key in an existing Animation value track. Use returned track index; time is within animation length. value is one Godot literal.',
    parameters: { project, path, subresource, track: { type: 'integer', required: true }, time: { type: 'number', required: true }, value }, output, presentCall,
    execute: (args, exec) => run('animation_key', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_theme_item', description: 'Set one Theme item for a control class such as Button. Use value for color/constant/font_size, reference for stylebox/icon/font.',
    parameters: { project, path, subresource, control: { type: 'string', required: true }, item: { type: 'string', required: true },
      kind: { type: 'string', required: true, enum: ['color', 'constant', 'font_size', 'stylebox', 'icon', 'font'] },
      value: { type: 'string', description: value.description }, reference: { type: 'string', description: reference.description } }, output, presentCall,
    execute: (args, exec) => {
      if ((args.value === undefined) === (args.reference === undefined)) throw new Error('Specify exactly one value or reference')
      return run('theme_item', args, exec)
    },
  }))
  ctx.tools.register(defineTool({ name: 'godot_tile_atlas', description: 'Add one imported texture atlas to a TileSet. source is a new nonnegative id; width/height are positive tile pixel dimensions.',
    parameters: { project, path, subresource, reference, source: { type: 'integer', required: true },
      width: { type: 'integer', required: true }, height: { type: 'integer', required: true } }, output, presentCall,
    execute: (args, exec) => run('tile_atlas', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_tile_create', description: 'Create one 1x1 tile at atlas grid coordinates x/y in an existing TileSet source. Engine rejects overlaps and out-of-bounds cells.',
    parameters: { project, path, subresource, source: { type: 'integer', required: true },
      x: { type: 'integer', required: true }, y: { type: 'integer', required: true } }, output, presentCall,
    execute: (args, exec) => run('tile_create', args, exec),
  }))
  const scenePath = { type: 'string', required: true, description: 'Project-relative .tscn path. Parent directory must exist.' } as const
  const node = { type: 'string', required: true, description: 'Node path in the scene. root selects the root; e.g. Player/Camera2D.' } as const
  const parent = { type: 'string', required: true, description: 'Existing parent node path; root selects the scene root.' } as const
  const nodeName = { type: 'string', required: true, description: 'One valid node name, without a slash or special path characters.' } as const
  ctx.tools.register(defineTool({ name: 'godot_scene_create',
    description: 'Create a native scene with one built-in root node using Vollkorn editing code. Does not overwrite files. No GUI or project plugin.',
    parameters: { project, path: scenePath, type: { type: 'string', required: true, description: 'Root class, e.g. Node2D, Node3D or Control.' } },
    output, presentCall, execute: (args, exec) => run('scene_create', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_scene_inspect',
    description: 'Read the native scene tree (default); script is its attached path or null. saved_connections lists up to 64 connections stored in this scene (. means root), with a truncation flag. view=properties reads one node; view=cells reads one TileMapLayer. Set node for those views.',
    parameters: { project, path: scenePath, view: { type: 'string', enum: ['tree', 'properties', 'cells'] },
      node: { type: 'string', description: node.description } }, output,
    presentCall: () => ({ card: 'generic', title: 'Inspect Godot scene', kind: 'read' }),
    execute: (args, exec) => {
      if (args.view !== undefined && args.view !== 'tree' && args.node === undefined) throw new Error('Specify node for this view')
      return run(args.view === 'properties' ? 'node_inspect' : args.view === 'cells' ? 'tile_cells' : 'scene_inspect', args, exec)
    },
  }))
  ctx.tools.register(defineTool({ name: 'godot_scene_instance',
    description: 'Instance one existing child .tscn under a parent and save, using Vollkorn ownership handling.',
    parameters: { project, path: scenePath, reference, parent, name: nodeName }, output, presentCall,
    execute: (args, exec) => run('scene_instance', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_node_add',
    description: 'Add one built-in node to a scene. Set its properties in later small calls; no node-tree JSON.',
    parameters: { project, path: scenePath, parent, name: nodeName, type: { type: 'string', required: true, description: 'Built-in Node class, e.g. Sprite2D, AnimationPlayer, TileMapLayer or CollisionShape2D.' } },
    output, presentCall, execute: (args, exec) => run('node_add', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_node_set',
    description: 'Set ONE native node property and save the scene. Accepts Godot literals; simple [x,y] values use Vollkorn type conversion. Inspect first.',
    parameters: { project, path: scenePath, node, property: { type: 'string', required: true }, value }, output, presentCall,
    execute: (args, exec) => run('node_set', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_node_reference',
    description: 'Assign one node property to an existing resource, e.g. shape, material, texture, tile_set or script. For script use a valid .gd with a matching node base class. Engine validates the resource class.',
    parameters: { project, path: scenePath, node, property: { type: 'string', required: true }, reference }, output, presentCall,
    execute: (args, exec) => run('node_reference', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_node_edit',
    description: 'Do ONE node edit. target is a new name for rename/duplicate, a parent path for reparent, a group name for group_add/group_remove, or target node for connect. connect also needs signal and method with matching argument counts; no bind/unbind. remove needs only node.',
    parameters: { project, path: scenePath, node,
      action: { type: 'string', required: true, enum: ['rename', 'remove', 'reparent', 'duplicate', 'group_add', 'group_remove', 'connect'] },
      target: { type: 'string' }, signal: { type: 'string' }, method: { type: 'string' } }, output, presentCall,
    execute: (args, exec) => {
      if (args.action !== 'remove' && args.target === undefined) throw new Error('Specify target for this edit')
      if (args.action === 'connect' && (args.signal === undefined || args.method === undefined)) throw new Error('Specify signal and method')
      return run(args.action === 'connect' ? 'signal_connect' : 'node_edit', args, exec)
    },
  }))
  ctx.tools.register(defineTool({ name: 'godot_animation_bind',
    description: 'Bind one existing Animation .tres into an AnimationPlayer default library using Vollkorn animation code. Edit tracks/keys with the resource tools first.',
    parameters: { project, path: scenePath, node, name: nodeName, reference }, output, presentCall,
    execute: (args, exec) => run('animation_bind', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_tileset_create',
    description: 'Create a TileSet from ONE texture atlas and automatically create all whole tiles, as in Vollkorn. The first source id is 0. Use tile_size dimensions in pixels.',
    parameters: { project, path, reference, width: { type: 'integer', required: true }, height: { type: 'integer', required: true } },
    output, presentCall, execute: (args, exec) => run('tileset_create', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_tile_cell',
    description: 'Set ONE TileMapLayer cell and save the scene. x/y are map coordinates; atlas_x/atlas_y select an existing atlas tile. source=-1 erases the cell.',
    parameters: { project, path: scenePath, node, x: { type: 'integer', required: true }, y: { type: 'integer', required: true },
      source: { type: 'integer', required: true }, atlas_x: { type: 'integer', required: true }, atlas_y: { type: 'integer', required: true } },
    output, presentCall, execute: (args, exec) => {
      if (args.source < -1) throw new Error('source must be -1 or a nonnegative id')
      return run('tile_cell', args, exec)
    },
  }))
  ctx.tools.register(defineTool({ name: 'godot_edit_batch',
    description: 'Apply 1–16 native edits atomically in one project (max 32 KiB input). operation uses scene_create/node_add/node_set/node_reference/resource_create/resource_set/resource_reference. Create needs type; node_add needs parent/name/type; node_set/reference needs node/property plus value/reference; resource_set/reference needs property plus value/reference. No script/file/shell edits. All steps commit together or roll back on a normal error. Refuses an already open transaction. Success replaces the latest worker-local undo group; godot_edit_transaction(action="undo") undoes the whole batch. Results include zero-based step indices. Not crash-safe: after interruption, rollback conflict or disk failure inspect files.',
    parameters: { project, operations: {
      type: 'array', required: true, description: '1–16 ordered edit objects. Use native scene-local node paths. Each value is one Godot literal string, not arbitrary code.',
      items: { type: 'object', additionalProperties: false, properties: {
        operation: { type: 'string', required: true, enum: ['scene_create', 'node_add', 'node_set', 'node_reference', 'resource_create', 'resource_set', 'resource_reference'] },
        path: { type: 'string', required: true, description: 'Project-relative .tscn for scene/node operations or .tres for resource operations; parent directory must exist.' },
        type: { type: 'string' }, parent: { type: 'string' }, name: { type: 'string' }, node: { type: 'string' }, property: { type: 'string' },
        value: { type: 'string', description: value.description }, reference: { type: 'string', description: reference.description },
        subresource,
      } },
    } }, output, presentCall,
    execute: (args, exec) => {
      if (args.operations.length < 1 || args.operations.length > 16) throw new Error('Use 1–16 batch operations')
      if (Buffer.byteLength(JSON.stringify(args.operations)) > 32768) throw new Error('Batch input exceeds 32 KiB; use smaller batches')
      const fields = {
        scene_create: ['type'], node_add: ['parent', 'name', 'type'], node_set: ['node', 'property', 'value'], node_reference: ['node', 'property', 'reference'],
        resource_create: ['type'], resource_set: ['property', 'value'], resource_reference: ['property', 'reference'],
      } as const
      const edits: GodotBatchEdit[] = args.operations.map((step, index) => {
        const { operation, ...values } = step
        const required: readonly string[] = fields[operation]
        const allowed = new Set(['path', ...required, ...(operation.startsWith('resource_') && operation !== 'resource_create' ? ['subresource'] : [])])
        for (const key of required) if (typeof values[key as keyof typeof values] !== 'string' || values[key as keyof typeof values] === '') throw new Error(`Batch step ${index}: ${operation} requires ${key}`)
        const normalized: Record<string, string> = {}
        for (const [key, value] of Object.entries(values)) {
          if (!allowed.has(key)) throw new Error(`Batch step ${index}: ${key} is not used by ${operation}`)
          normalized[key] = value
        }
        const native = { resource_create: 'create', resource_set: 'set', resource_reference: 'reference' } as const
        return { operation: operation in native ? native[operation as keyof typeof native] : operation, args: normalized }
      })
      return worker.request(args.project, 'batch', {}, exec, edits)
    },
  }))
  ctx.tools.register(defineTool({ name: 'godot_edit_transaction',
    description: 'Individual native edits already save; a transaction is optional. For a group: begin ONCE, make native edits, then commit. rollback restores the open group; undo restores the latest committed group. When a failure reports rollback completed, the group is closed: fix the input instead of calling rollback again. A commit with files=[] tracked no native edits; it does not cover generic write/bash changes. Tracks native target files only (16 MiB of original file data), not ordinary file-tool/script edits. Refuses external-change conflicts. Worker-local history expires on stop/idle/turn end; finish groups promptly. A killed worker is NOT crash-safe; inspect disk after interruption.',
    parameters: { project, action: { type: 'string', required: true, enum: ['begin', 'commit', 'rollback', 'undo'] } },
    output, presentCall, execute: (args, exec) => run('transaction', args, exec),
  }))
  ctx.tools.register(defineTool({ name: 'godot_worker_stop', description: 'Finish native resource editing and release the Headless worker. Also stops automatically at turn completion and after idle expiry.',
    parameters: {}, output, presentCall: () => ({ card: 'generic', title: 'Stop Godot worker' }), execute: () => worker.stop(),
  }))
}
