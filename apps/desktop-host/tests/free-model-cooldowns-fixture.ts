import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'

/** Install the actual public JSON/domain backend in an isolated test home. */
export async function bootCooldownStorage(ctx: Context, root?: string): Promise<string> {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'free-cooldown-'))
  if (root === undefined) ctx.effect(() => () => rm(directory, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(Json, { root: directory })
  await ctx.plugin(Domain, { backend: 'json', routes: {} })
  return directory
}
