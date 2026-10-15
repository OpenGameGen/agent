/** Opt-in real API smoke through production model and interactive request tools. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import * as horde from '../src/aihorde-images.ts'

it.skipIf(process.env.AI_HORDE_LIVE !== '1')('discovers models, submits, observes real progress and saves an AI Horde image', async () => {
  const root = resolve('../validation/2026-10-13/aihorde')
  await mkdir(root, { recursive: true })
  const restoreProxy = await installProxyFromEnvironment(
    createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env as Record<string, string> }]), (message) => { console.error(message) })
  const ctx = new Context(), evidence: object[] = []
  const queueOnly = process.env.AI_HORDE_LIVE_MODE === 'queue'
  const evidenceFile = join(root, `tracked-${queueOnly ? 'queue' : 'complete'}-${Date.now()}.json`)
  const signal = AbortSignal.timeout(Number(process.env.AI_HORDE_TEST_TIMEOUT_MS ?? 600_000))
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Projections); await ctx.plugin(Tools)
    await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: root })
    const fiber = await ctx.plugin(horde); await fiber.await()
    const call = async (name: string, args: object) => {
      const result = await ctx.tools.execute({ callId: ToolCallId('horde-live'), name, arguments: args, signal })
      evidence.push({ name, ...result })
      await writeFile(evidenceFile, JSON.stringify(evidence, null, 2))
      expect(result.isError, JSON.stringify(result)).toBe(false)
      return JSON.parse(result.value as string) as Record<string, unknown>
    }
    const models = await call('aihorde_list_models', { search: process.env.AI_HORDE_TEST_MODEL ?? 'Flat-2D Animerge' })
    expect(models.totalMatching).toBeGreaterThan(0)
    const candidates = models.models as { name: string; workers: number }[]
    const model = candidates[0]?.name
    expect(model).toBeDefined()
    const submitted = await call('aihorde_image_request', { action: 'submit',
      prompt: 'A friendly small green robot holding a paintbrush, simple game concept art, white background, no text',
      output: join(root, `tracked-robot-${Date.now()}.png`), width: 512, height: 512, steps: 10, model })
    console.log('SUBMITTED', JSON.stringify(submitted))
    let checks = 0
    while (true) {
      const status = await call('aihorde_image_request', { action: 'status', request_id: submitted.request_id })
      console.log('PROGRESS', JSON.stringify(status))
      expect(status.faulted).toBe(false)
      if (queueOnly && ++checks >= 2) {
        console.log('CANCELLED', JSON.stringify(await call('aihorde_image_request', { action: 'cancel', request_id: submitted.request_id })))
        return
      }
      if (status.done === true) break
      await delay(3000, undefined, { signal })
    }
    console.log('SAVED', JSON.stringify(await call('aihorde_image_request', { action: 'save', request_id: submitted.request_id })))
  } finally { await ctx.fiber.dispose(); await restoreProxy() }
}, 620_000)
