/** Durable, home-scoped anonymous-route Retry-After observations. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const spec = defineDomain({
  name: 'product_free_cooldowns', version: 1,
  tables: { routes: domainTable(z.object({
    provider: z.string().min(1), model: z.string().min(1), notBefore: z.number().nonnegative().max(8640000000000000),
  }).strict()) },
})

/** Open only anonymous-route metadata; failed storage falls back to Host memory.
 * @param ctx Plugin lifecycle owning the domain.
 * @param provider Anonymous provider id, never a paid account.
 * @returns Shared cooldown map and serialized durable observation writer.
 */
export function createCooldowns(ctx: Context, provider: string) {
  const times = new Map<string, number>()
  let domain: Domain<typeof spec> | undefined
  let disposed = false
  let queue = Promise.resolve()
  const warn = () => { ctx.logger.warn('Free-model cooldown persistence unavailable; cooldowns are limited to this Host process.') }
  const ready = ctx.storageDomain.open(spec).then(async (opened) => {
    if (disposed) { await opened.close(); return }
    domain = opened
    const table = opened.table('routes')
    const expired: string[] = []
    for (const [key, record] of table.entries()) {
      if (record.notBefore <= Date.now()) expired.push(key)
      else if (record.provider === provider) times.set(record.model, Math.max(times.get(record.model) ?? 0, record.notBefore))
    }
    for (const key of expired) await table.delete(key).catch(warn)
  }).catch(warn)
  ctx.effect(() => async () => {
    disposed = true
    await ready
    await queue
    await domain?.close()
  })
  const settle = async (operation: Promise<void>, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Free-model cooldown loading aborted', { cause: signal.reason })) }
      signal.addEventListener('abort', abort, { once: true })
    })
    try { await Promise.race([operation, cancelled]); signal.throwIfAborted() }
    finally { if (abort !== undefined) signal.removeEventListener('abort', abort) }
  }
  return {
    times,
    load: (signal: AbortSignal) => settle(ready, signal),
    remember(model: string, notBefore: number, signal?: AbortSignal): Promise<void> {
      const timestamp = Math.max(times.get(model) ?? 0, notBefore)
      times.set(model, timestamp)
      queue = queue.then(async () => {
        await ready
        if (domain === undefined) return
        const table = domain.table('routes')
        const key = JSON.stringify([provider, model])
        const latest = Math.max(times.get(model) ?? timestamp, table.get(key)?.notBefore ?? 0)
        if (latest > Date.now()) await table.put(key, { provider, model, notBefore: latest })
        else await table.delete(key)
      }).catch(warn)
      return signal === undefined ? queue : settle(queue, signal)
    },
  }
}
