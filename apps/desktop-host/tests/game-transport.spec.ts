import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { createGameTransport } from '../src/game-transport.ts'

it.each(['TimeoutError', 'AbortError'])('distinguishes %s and requests browser cleanup', async (name) => {
  const events = new EventEmitter()
  const send = vi.fn()
  vi.stubGlobal('process', { connected: true, send, on: events.on.bind(events), off: events.off.bind(events) })
  const transport = createGameTransport()
  try {
    const controller = new AbortController()
    const request = transport.request('open', {}, controller.signal)
    controller.abort(new DOMException(name === 'TimeoutError' ? 'deadline expired' : 'user cancelled', name))
    await expect(request).rejects.toThrow(name === 'TimeoutError' ? 'Game open timed out' : 'Game operation cancelled or interrupted')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ operation: 'cancel' }))
  } finally { transport.dispose(); vi.unstubAllGlobals() }
})

it('routes generation and cancellation through the Perchance namespace', async () => {
  const events = new EventEmitter(), send = vi.fn()
  vi.stubGlobal('process', { connected: true, send, on: events.on.bind(events), off: events.off.bind(events) })
  const transport = createGameTransport('perchance:')
  try {
    const controller = new AbortController()
    const request = transport.request('generate', { prompt: 'robot' }, controller.signal)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ operation: 'perchance:generate' }), expect.any(Function))
    controller.abort()
    await expect(request).rejects.toThrow()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ operation: 'perchance:cancel' }))
  } finally { transport.dispose(); vi.unstubAllGlobals() }
})
