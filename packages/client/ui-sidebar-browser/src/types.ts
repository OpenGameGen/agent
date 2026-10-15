/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
  /** Present for main-approved game or tool reservations; constrains the first navigation. */
  readonly approvedInitialUrl?: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Main-owned identity of a tool's dedicated ordinary Browser tab. */
export interface DesktopToolBrowserRequest {
  readonly id: string
  readonly sessionId: string
  readonly url: string
  readonly title: string
  readonly reuse?: boolean
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** Open/reveal a main-authorized dedicated ordinary Browser tab. */
  onToolTabOpen?(listener: (request: DesktopToolBrowserRequest) => void): () => void
  /** Retire only the tab with this main-issued identity in its owning task. */
  onToolTabClosed?(listener: (request: { id: string; sessionId: string; preserve?: boolean }) => void): () => void

  /** Subscribe to shell-authorized requests to open a game in the visible session. */
  onGameOpen?(listener: (request: { sessionId: string; url: string; reuse?: boolean }) => void): () => void

  /** Subscribe after a product-owned game guest is closed; unrelated tabs are unaffected. */
  onGameClosed?(listener: (request: { sessionId: string; url: string }) => void): () => void

  /** @param workspace - resolved storage account. @param initialUrl - pending target for main-approved game isolation.
   * @returns one approved guest reservation. */
  acquire(workspace: string, initialUrl?: string, toolTabId?: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
