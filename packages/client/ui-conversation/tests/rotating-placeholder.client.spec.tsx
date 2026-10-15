// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DraftEditor } from '../src/client/input/editor/DraftEditor.tsx'

afterEach(() => { cleanup(); vi.useRealTimers() })
it('rotates every five seconds, pauses for focus and content, and clears its timer', () => {
  vi.useFakeTimers()
  const props = { classNames: {}, editor: null, scrollRef: { current: null }, editable: true,
    editorDisabled: false, phase: 'inert' as const, placeholderText: 'Describe your game',
    ariaLabel: 'Describe your game', workspaceTrigger: true, workspacePickerOpen: false,
    onWorkspaceKeyDown: () => {}, hint: null, showPlaceholder: true, placeholderExamples: ['First', 'Second'] }
  const view = render(<DraftEditor {...props} />)
  expect(view.getByText('First')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(5000) })
  expect(view.getByText('Second')).toBeTruthy()
  fireEvent.focus(view.getByRole('textbox'))
  act(() => { vi.advanceTimersByTime(10000) })
  expect(view.getByText('Second')).toBeTruthy()
  fireEvent.blur(view.getByRole('textbox'))
  act(() => { vi.advanceTimersByTime(5000) })
  expect(view.getByText('First')).toBeTruthy()
  view.rerender(<DraftEditor {...props} showPlaceholder={false} />)
  expect(vi.getTimerCount()).toBe(0)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
