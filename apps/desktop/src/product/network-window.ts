/** Native menu-owned diagnostics window serving the authenticated Host plugin page. */
import { BrowserWindow } from 'electron'

/** Retains one diagnostics window across repeated menu clicks. */
export class NetworkDiagnosticsWindow {
  private window: BrowserWindow | undefined

  /** @param hostUrl - Current authenticated Host origin. @param title - Shell locale title. @param chinese - Page locale. */
  async show(hostUrl: string, title: string, chinese: boolean): Promise<void> {
    const url = new URL('/product/network', hostUrl)
    url.searchParams.set('lang', chinese ? 'zh' : 'en')
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.webContents.getURL() !== url.href) await this.window.loadURL(url.href)
      this.window.show(); this.window.focus(); return
    }
    const window = new BrowserWindow({ width: 1060, height: 740, minWidth: 760, minHeight: 480, title,
      autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    this.window = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, target) => { if (target !== url.href) event.preventDefault() })
    window.on('closed', () => { if (this.window === window) this.window = undefined })
    await window.loadURL(url.href)
  }
}
