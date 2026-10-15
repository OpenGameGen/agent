import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createCooldowns } from '../src/free-model-cooldowns.ts'
import { bootCooldownStorage } from './free-model-cooldowns-fixture.ts'

it('persists max Retry-After across Host lifetimes and isolates providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cooldown-restart-'))
  const future = Date.now() + 60000
  let ctx = new Context()
  try {
    await bootCooldownStorage(ctx, root)
    let store = createCooldowns(ctx, 'anonymous')
    await store.load(new AbortController().signal)
    await Promise.all([store.remember('model', future), store.remember('model', future - 1000)])
    await ctx.fiber.dispose()
    ctx = new Context(); await bootCooldownStorage(ctx, root)
    store = createCooldowns(ctx, 'anonymous'); await store.load(new AbortController().signal)
    expect(store.times.get('model')).toBe(future)
    await ctx.fiber.dispose()
    ctx = new Context(); await bootCooldownStorage(ctx, root)
    store = createCooldowns(ctx, 'paid'); await store.load(new AbortController().signal)
    expect(store.times.size).toBe(0)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('cleans expired records and degrades corrupt storage to memory without rewriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cooldown-corrupt-'))
  let ctx = new Context()
  try {
    await bootCooldownStorage(ctx, root)
    let store = createCooldowns(ctx, 'anonymous'); await store.load(new AbortController().signal)
    await store.remember('expired', Date.now() - 100)
    expect(await readFile(join(root, 'product_free_cooldowns.json'), 'utf8').catch(() => '')).not.toContain('expired')
    await ctx.fiber.dispose()
    await writeFile(join(root, 'product_free_cooldowns.json'), '{broken')
    ctx = new Context(); await bootCooldownStorage(ctx, root)
    store = createCooldowns(ctx, 'anonymous'); await store.load(new AbortController().signal)
    await store.remember('memory', Date.now() + 60000)
    expect(store.times.has('memory')).toBe(true)
    expect(await readFile(join(root, 'product_free_cooldowns.json'), 'utf8')).toBe('{broken')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('preserves cancellation reason while initialization completes and closes normally', async () => {
  const ctx = new Context()
  try {
    await bootCooldownStorage(ctx)
    const store = createCooldowns(ctx, 'anonymous')
    await expect(store.load(AbortSignal.abort('user stopped'))).rejects.toBe('user stopped')
    await store.load(new AbortController().signal)
    expect(store.times.size).toBe(0)
  } finally { await ctx.fiber.dispose() }
})


it('aborts while initialization is pending and keeps memory on a durable write failure', async () => {
  const ctx = new Context()
  try {
    await bootCooldownStorage(ctx)
    const open = ctx.storageDomain.open.bind(ctx.storageDomain)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (spec) => {
      await gate
      const domain = await open(spec)
      vi.spyOn(domain.table('routes'), 'put').mockRejectedValue(new Error('disk full'))
      return domain
    })
    const store = createCooldowns(ctx, 'anonymous')
    const controller = new AbortController()
    const pending = store.load(controller.signal)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')
    release?.()
    await store.load(new AbortController().signal)
    await store.remember('route', Date.now() + 60000)
    expect(store.times.has('route')).toBe(true)
  } finally { await ctx.fiber.dispose() }
})


it('cancels caller waiting for a pending durable write without losing the observation', async () => {
  const ctx = new Context()
  let release: (() => void) | undefined
  try {
    await bootCooldownStorage(ctx)
    const open = ctx.storageDomain.open.bind(ctx.storageDomain)
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (spec) => {
      const domain = await open(spec)
      const table = domain.table('routes')
      const put = table.put.bind(table)
      vi.spyOn(table, 'put').mockImplementation(async (...args) => { await gate; await put(...args) })
      return domain
    })
    const store = createCooldowns(ctx, 'anonymous')
    await store.load(new AbortController().signal)
    const controller = new AbortController()
    const pending = store.remember('route', Date.now() + 60000, controller.signal)
    controller.abort(new Error('cancel disk wait'))
    await expect(pending).rejects.toThrow('cancel disk wait')
    expect(store.times.has('route')).toBe(true)
  } finally { release?.(); await ctx.fiber.dispose() }
})


it('loads valid observations even when earlier expired-record cleanup cannot write', async () => {
  const ctx = new Context()
  try {
    await bootCooldownStorage(ctx)
    const open = ctx.storageDomain.open.bind(ctx.storageDomain)
    const future = Date.now() + 60000
    vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (spec) => {
      const domain = await open(spec)
      const table = domain.table('routes')
      vi.spyOn(table, 'entries').mockReturnValue(new Map([
        ['expired', { provider: 'anonymous', model: 'old', notBefore: 1 }],
        ['valid', { provider: 'anonymous', model: 'next', notBefore: future }],
      ]).entries())
      vi.spyOn(table, 'delete').mockRejectedValue(new Error('read only'))
      return domain
    })
    const store = createCooldowns(ctx, 'anonymous')
    await store.load(new AbortController().signal)
    expect([...store.times]).toEqual([['next', future]])
  } finally { await ctx.fiber.dispose() }
})
