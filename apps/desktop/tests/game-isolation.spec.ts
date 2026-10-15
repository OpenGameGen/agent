import { expect, it, vi } from 'vitest'
const sessions = vi.hoisted(() => new Map<string, {
  closeAllConnections: ReturnType<typeof vi.fn>
  clearStorageData: ReturnType<typeof vi.fn>
  clearCache: ReturnType<typeof vi.fn>
}>())
vi.mock('electron', () => ({ app: {}, session: { fromPartition: (partition: string) => {
  let value = sessions.get(partition)
  if (value === undefined) {
    value = { closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}) }
    sessions.set(partition, value)
  }
  return { ...value, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(), on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } }
} } }))
import { DesktopBrowserGuests } from '../src/browser-guests.ts'
const url = 'http://127.0.0.1:1234/game/cold/index.html'
it('requires main-approved owner and exact URL, consumes once, preserves normal workspace sharing', async () => {
  const guests = new DesktopBrowserGuests(() => undefined), owner = {} as never, other = {} as never
  const ordinary = guests.acquire(owner, 'workspace')
  const approval = guests.isolateNextGame(owner, url)
  expect(guests.acquire(other, 'workspace', url).partition).toBe(ordinary.partition)
  expect(guests.acquire(owner, 'workspace', url + '?other').partition).toBe(ordinary.partition)
  const cold = guests.acquire(owner, 'workspace', url)
  expect(cold.approvedInitialUrl).toBe(url); expect(ordinary.approvedInitialUrl).toBeUndefined()
  expect(cold.partition).not.toBe(ordinary.partition); expect(cold.partition.startsWith('persist:')).toBe(false)
  expect(guests.acquire(owner, 'workspace', url).partition).toBe(ordinary.partition)
  await approval.cancel()
  expect(sessions.get(cold.partition)?.clearStorageData).toHaveBeenCalledOnce()
  expect(sessions.get(ordinary.partition)?.clearStorageData).not.toHaveBeenCalled()
  const next = guests.isolateNextGame(owner, url), nextCold = guests.acquire(owner, 'workspace', url)
  expect(nextCold.partition).not.toBe(cold.partition)
  await next.cancel()
})
it('cleans consumed unattached leases and revokes unused approvals', async () => {
  const guests = new DesktopBrowserGuests(() => undefined), owner = {} as never
  const unused = guests.isolateNextGame(owner, url); await unused.cancel()
  expect(guests.acquire(owner, 'workspace', url).partition).toContain('dsh-sidebar-browser-')
  const approval = guests.isolateNextGame(owner, url), cold = guests.acquire(owner, 'workspace', url)
  await approval.cancel(); await approval.cancel()
  expect(sessions.get(cold.partition)?.closeAllConnections).toHaveBeenCalledOnce()
  expect(sessions.get(cold.partition)?.clearCache).toHaveBeenCalledOnce()
})

it('binds a dedicated tool guest by main identity while preserving ordinary workspace and game partitions', async () => {
  const guests = new DesktopBrowserGuests(() => undefined), owner = {} as never, other = {} as never
  const page = 'https://perchance.org/img-generator'
  const ordinary = guests.acquire(owner, 'workspace', page)
  const revoke = guests.authorizeToolTab(owner, 'tool-1', page)
  expect(() => guests.acquire(other, 'workspace', page, 'tool-1')).toThrow('authorization')
  expect(() => guests.acquire(owner, 'workspace', page + '?other', 'tool-1')).toThrow('authorization')
  expect(() => guests.acquire(owner, 'workspace', page, 'forged')).toThrow('authorization')
  expect(guests.findToolTab(owner, 'tool-1')).toBeUndefined()
  const tool = guests.acquire(owner, 'workspace', page, 'tool-1')
  expect(tool.partition).toBe(ordinary.partition)
  expect(tool.approvedInitialUrl).toBe(page)
  expect(() => guests.acquire(owner, 'workspace', page, 'tool-1')).toThrow('consumed')
  const gameApproval = guests.isolateNextGame(owner, url)
  const game = guests.acquire(owner, 'workspace', url)
  expect(game.partition).not.toBe(tool.partition)
  await revoke()
  expect(sessions.get(ordinary.partition)?.clearStorageData).not.toHaveBeenCalled()
  expect(sessions.get(game.partition)?.clearStorageData).not.toHaveBeenCalled()
  await gameApproval.cancel()
  expect(sessions.get(game.partition)?.clearStorageData).toHaveBeenCalledOnce()
})
