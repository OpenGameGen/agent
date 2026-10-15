/** Host configuration for initial panel presentation. */
import z from '@deepseek-ai/schemastery'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

/** Initial presentation; user controls remain available. */
export interface Config {
  /** Initial panel preference for a fresh layout. */
  sidebarInitiallyCollapsed: Volatile<boolean>
}

/** Validate profile defaults before projecting them to the browser. */
export const Config = z.object({ sidebarInitiallyCollapsed: z.boolean().default(false).volatile() })

/** Browser-only behavior. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
