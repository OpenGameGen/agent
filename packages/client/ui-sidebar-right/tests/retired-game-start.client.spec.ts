// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createSidebarRightStore } from '../src/client/stores.ts'

afterEach(() => { localStorage.clear() })

it('restores retired game start tabs as the normal start page while keeping other tabs and pane identities', () => {
  const session = 'retired-start-session'
  const handle = createSidebarRightStore(() => ({ kind: 'guide', title: '开始' }))
  const old = handle.create(session)
  old.actions.open(session)
  old.actions.openContent(session, { kind: 'game-start', contentId: 'sidebar://game-start', title: 'Star Garden' }, () => {})
  old.actions.openContent(session, { kind: 'browser', contentId: 'https://example.com/', title: 'Existing browser' }, () => {})
  const previous = old.getSnapshot().bySession[session]!
  const restored = handle.create(session).getSnapshot().bySession[session]!
  expect(restored.layout.nodes).toEqual(previous.layout.nodes)
  expect(restored.layout.activePaneId).toBe(previous.layout.activePaneId)
  expect(Object.keys(restored.layout.tabs)).toEqual(Object.keys(previous.layout.tabs))
  expect(Object.values(restored.layout.tabs).find(tab => tab.title === '开始')).toMatchObject({ kind: 'guide', contentId: 'sidebar://guide' })
  expect(Object.values(restored.layout.tabs).find(tab => tab.kind === 'browser')).toEqual(Object.values(previous.layout.tabs).find(tab => tab.kind === 'browser'))
})
