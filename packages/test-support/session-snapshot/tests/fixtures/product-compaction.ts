/** Keyless product policy witness through a real isolated Agent preset. */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
export const inject = ['agentPresets']
export async function apply(ctx: Context): Promise<void> {
  const patches = load(readFileSync(new URL('../../../../../apps/desktop-host/resources/product-defaults.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
  const rows = applyEntryPatches([{ id: 'preset-standard', name: 'fixture', config: { plugins: [{ name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }, { name: new URL('./product-compaction-tool.ts', import.meta.url).href }] }] } }], patches.filter(patch => patch.preset !== undefined), (message) => { throw new Error(message) })
  const configured = rows[0]!.config as { plugins: import('@deepseek-ai/cordis-plugin-loader').EntryOptions[] }
  const dispose = await ctx.agentPresets.register({ id: 'standard', plugins: configured.plugins })
  ctx.effect(() => dispose)
  ctx.on('agent/created', async ({ agent }) => { await ctx.agentPresets.select(agent, 'standard') })
}
