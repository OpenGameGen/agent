/** Tool witness mounted inside the actual preset compaction scope. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type BasicCompaction from '../../../../compaction/compaction-basic/src/index.ts'
import { resolveCompactSpec, resolveTargetPolicy } from '../../../../compaction/compaction-basic/src/config.ts'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
export const inject = ['tools', 'compaction', 'agentPresets']
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({ name: 'audit_product_policy', description: 'Read the active isolated compaction policy.', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute(_args, exec) {
    if (!exec.agent) throw new Error('Expected a real Agent')
    const service = ctx.compaction as BasicCompaction
    const policy = resolveTargetPolicy(service.config, { provider: 'our-free-model', model: 'nemotron-3.5-lightning-free' })
    const spec = resolveCompactSpec(policy, 128000, 32768)
    return JSON.stringify({ presetSelected: ctx.agentPresets.composedPreset(exec.agent.ctx) === 'standard', thresholdTokens: spec.thresholdTokens,
      summaryMaxTokens: spec.maxTokens, input42000BelowThreshold: 42000 < spec.thresholdTokens,
      input80000AboveThreshold: 80000 > spec.thresholdTokens })
  } }))
}
