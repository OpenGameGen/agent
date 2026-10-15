/** OpenGameGen occupants for public sidebar brand slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ProductBrandMark, ProductBrandName } from './Brand.tsx'

/** Required slot registry. */
export const inject = ['slots']

/** Register product branding with declaration-aware disposal. */
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, ProductBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, ProductBrandName)
    }))
}
