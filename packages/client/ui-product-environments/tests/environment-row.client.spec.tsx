// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { EnvironmentRow } from '../src/client/EnvironmentRow.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('opens the fixed native manager from General Settings and surfaces failures', async () => {
  const open = vi.fn(async () => {})
  vi.stubGlobal('dshDesktop', { environments: { open } })
  const props = { t: (key: string) => ({ title: '创作环境管理', description: '按需准备', open: '管理环境', failed: '打开失败' })[key] ?? key } as unknown as ComponentProps<typeof EnvironmentRow>
  render(<EnvironmentRow {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '管理环境' }))
  await waitFor(() => { expect(open).toHaveBeenCalledOnce() })
  expect(open.mock.calls[0]).toEqual([])
  open.mockRejectedValueOnce(new Error('unavailable'))
  fireEvent.click(screen.getByRole('button', { name: '管理环境' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('打开失败') })
})
