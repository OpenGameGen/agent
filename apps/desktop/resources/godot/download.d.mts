export interface DownloadAsset { name: string; url: string; mirrors?: string[]; size: number; sha256: string }
export function downloadPinned(asset: DownloadAsset, directory: string, options?: { prefix?: string; probeMs?: number; sampleBytes?: number; idleMs?: number; timeoutMs?: number; attempts?: number }): Promise<string>
