/** Lease-scoped browser operations and one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopToolBrowserRequest } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  ipcRenderer.on(DESKTOP_IPC.browserOpenRequested, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  return {
    onToolTabOpen(listener) {
      const receive = (_event: Electron.IpcRendererEvent, request: DesktopToolBrowserRequest & { requestId: string }): void => {
        try { listener(request); ipcRenderer.send(DESKTOP_IPC.browserToolTabOpened, { requestId: request.requestId }) }
        catch (error) { ipcRenderer.send(DESKTOP_IPC.browserToolTabOpened, { requestId: request.requestId, error: String(error) }) }
      }
      ipcRenderer.on(DESKTOP_IPC.browserToolTabOpen, receive)
      return () => { ipcRenderer.off(DESKTOP_IPC.browserToolTabOpen, receive) }
    },
    onToolTabClosed(listener) {
      const receive = (_event: Electron.IpcRendererEvent, request: unknown): void => {
        if (typeof request !== 'object' || request === null || !('id' in request) || typeof request.id !== 'string'
          || !('sessionId' in request) || typeof request.sessionId !== 'string') return
        try { listener({ id: request.id, sessionId: request.sessionId, ...('preserve' in request && request.preserve === true ? { preserve: true } : {}) }) }
        catch (error) { console.error('Desktop tool tab close handler failed', error) }
      }
      ipcRenderer.on(DESKTOP_IPC.browserToolTabClosed, receive)
      return () => { ipcRenderer.off(DESKTOP_IPC.browserToolTabClosed, receive) }
    },
    onGameOpen(listener) {
      const receive = (_event: Electron.IpcRendererEvent,
        request: { id: string; sessionId: string; url: string; reuse?: boolean }): void => {
        try { listener(request); ipcRenderer.send(DESKTOP_IPC.browserGameOpened, { id: request.id }) }
        catch (error) { ipcRenderer.send(DESKTOP_IPC.browserGameOpened, { id: request.id, error: String(error) }) }
      }
      ipcRenderer.on(DESKTOP_IPC.browserGameOpen, receive)
      return () => { ipcRenderer.off(DESKTOP_IPC.browserGameOpen, receive) }
    },
    onGameClosed(listener) {
      const receive = (_event: Electron.IpcRendererEvent, request: unknown): void => {
        if (typeof request !== 'object' || request === null || !('sessionId' in request) || !('url' in request)
          || typeof request.sessionId !== 'string' || typeof request.url !== 'string') return
        try { listener({ sessionId: request.sessionId, url: request.url }) }
        catch (error) { console.error('Desktop game close handler failed', error) }
      }
      ipcRenderer.on(DESKTOP_IPC.browserGameClosed, receive)
      return () => { ipcRenderer.off(DESKTOP_IPC.browserGameClosed, receive) }
    },
    acquire: (workspace, initialUrl, toolTabId) => (toolTabId === undefined
      ? ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace, initialUrl)
      : ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace, initialUrl, toolTabId)) as ReturnType<DesktopBrowserBridge['acquire']>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}
