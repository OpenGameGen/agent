/** On-demand environment entry through public General Settings slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EnvironmentRow } from './EnvironmentRow.tsx'

const zh = { title: '创作环境管理', description: '检测本机 Godot、Blender，按需准备缺失工具和导出模板。', open: '管理环境', failed: '无法打开环境管理，请重试。' }
const en = { title: 'Creation environments', description: 'Detect local Godot and Blender; prepare missing tools and export templates on demand.', open: 'Manage environments', failed: 'Could not open environment management. Try again.' }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { productEnvironments: keyof typeof zh }
}
export const inject = ['slots', 'locale']

/** Register the product-profile General Settings entry. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('productEnvironments', { zh, en }))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'product-environments', order: 5, locale: 'productEnvironments' }, EnvironmentRow))
}
