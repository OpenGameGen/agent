/** Product presets derive from the running upstream Standard composition. */
import type { Context } from '@deepseek-ai/cordis'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
export const inject = ['agentPresets']
export const name = 'product-engine-presets'
/** Keep the upstream composition current instead of copying its implementation. */
export async function apply(ctx: Context): Promise<void> {
  const standard = await ctx.agentPresets.readDocument('standard')
  const plugins = load(standard.content, { schema: entryListSchema }) as PresetDefinition['plugins']
  // Keep the historical Three.js preset loadable without showing it in the product selector.
  for (const [id, label, engine] of [['threejs', 'Three.js', 'threejs'], ['godot', 'Godot', 'godot'], ['general', '通用', 'general']] as const) {
    const dispose = await ctx.agentPresets.register({ id, name: label, order: engine === 'general' ? -3 : engine === 'godot' ? -2 : 100,
      plugins: [...plugins, { id: 'product-engine-agent', name: new URL('../lib/engine-agent.js', import.meta.url).href, config: { engine } }],
    })
    ctx.effect(() => dispose)
  }
}
