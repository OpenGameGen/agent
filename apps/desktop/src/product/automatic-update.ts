/** Product scheduling only; the existing coordinator owns integrity, task protection and restart. */
import type { DesktopUpdateState } from '../ipc.ts'
export class ProductAutomaticDownload {
  private readonly attempted = new Set<string>()
  private stopped = false
  constructor(private readonly download: (version: string) => Promise<unknown>) {}
  observe(state: DesktopUpdateState): void {
    if (this.stopped || state.phase !== 'available' || !state.version || this.attempted.has(state.version)) return
    const version = state.version
    this.attempted.add(version)
    if (this.attempted.size > 32) {
      const oldest = this.attempted.values().next().value
      if (oldest !== undefined) this.attempted.delete(oldest)
    }
    queueMicrotask(() => { if (!this.stopped) void this.download(version).catch((error: unknown) => { console.error('Product update download failed', error) }) })
  }
  dispose(): void { this.stopped = true }
}
