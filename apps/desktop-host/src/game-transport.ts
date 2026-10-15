/** Correlated product game requests over the existing private Desktop child IPC. */
import { randomUUID } from 'node:crypto'

/** Request only product-owned browser operations; never arbitrary JavaScript. */
export type GameTransport = (operation: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

/** @returns One IPC transport and its awaited-listener cleanup. */
export function createGameTransport(prefix = ''): { request: GameTransport; dispose: () => void } {
  const label = prefix === 'perchance:' ? 'Perchance' : 'Game'
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const receive = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'game-response'
      || !('id' in message) || typeof message.id !== 'string') return
    const request = pending.get(message.id)
    if (request === undefined) return
    if ('error' in message) request.reject(new Error(String(message.error)))
    else request.resolve('value' in message ? message.value : null)
  }
  process.on('message', receive)
  return {
    async request(operation, args, signal) {
      signal.throwIfAborted()
      if (!process.connected || process.send === undefined) throw new Error(`${label} tools require the Desktop shell`)
      const id = randomUUID()
      let abort: (() => void) | undefined
      try {
        return await new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject })
          abort = () => {
            process.send?.({ type: 'game-request', id: randomUUID(), operation: `${prefix}cancel`, args: { requestId: id } })
            reject(new Error(signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
              ? `${label} ${operation} timed out while waiting for the Desktop browser: ${signal.reason.message}. Cancellation requested; test outcome unknown. Retry after checking the startup scene and browser errors.`
              : `${label} operation cancelled or interrupted; cancellation requested and outcome unknown`))
          }
          signal.addEventListener('abort', abort, { once: true })
          process.send?.({ type: 'game-request', id, operation: prefix + operation, args }, (error) => { if (error !== null) reject(error) })
          if (signal.aborted) abort()
        })
      } finally { pending.delete(id); if (abort !== undefined) signal.removeEventListener('abort', abort) }
    },
    dispose() {
      if (prefix && process.connected) for (const id of pending.keys()) process.send?.({ type: 'game-request', id: randomUUID(), operation: `${prefix}cancel`, args: { requestId: id } })
      process.off('message', receive)
      for (const request of pending.values()) request.reject(new Error(`${label} plugin disposed`))
      pending.clear()
    },
  }
}
