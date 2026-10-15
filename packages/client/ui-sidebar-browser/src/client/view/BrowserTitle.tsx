/** Live Browser tab title from the Browser store. */
import type { ReactNode } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import type { BrowserStore } from '../browser/store.ts'
import css from './Browser.module.css'

/** Browser title props assembled by the Sidebar title seat. */
export type BrowserTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & PropsStore<BrowserStore>

/** Browser icon and current host name. */
export function BrowserTitle({ useTabInfo, useStore }: BrowserTitleProps): ReactNode {
  const { tab } = useTabInfo()
  const entry = useStore(state => currentBrowserTarget(state.byTab[tab.id]))
  const params = tab.navigation.params
  const toolTitle = !entry || params?.url === undefined || entry.url === params.url ? params?.toolTitle : undefined
  return <><IconGlobeOutlineRegular className={css.titleIcon} />{toolTitle ?? entry?.title ?? tab.title}</>
}
