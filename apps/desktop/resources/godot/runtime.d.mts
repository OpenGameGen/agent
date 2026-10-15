/** Static contracts for the unbundled Node CLI resources. */
export interface Asset { name: string; url: string; mirrors?: string[]; sha256: string; size: number }
export interface ReleaseLock { version: string; release: string; assets: { darwin: Asset; win32: Asset; templates: Asset } }
export interface Runtime {
  executable: string
  templates: string
  requireEngine?(): Promise<string>
  ensureEngine(repair?: boolean): Promise<string>
  ensureTemplates(repair?: boolean): Promise<string>
  status(): Promise<{ version: string; executable: string; engineInstalled: boolean; source?: string; templates: string; templatesInstalled: boolean; templatesNeedRepair?: boolean }>
}
export function exists(path: string): Promise<boolean>
export function execute(executable: string, args: string[], options?: {
  startupProjectConfig?: string; operation?: string; detectErrors?: boolean; quiet?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void
}): Promise<{ code: number; output: string; diagnostic: boolean }>
export function download(asset: Asset, directory: string): Promise<string>
export function createRuntime(options: { root: string; python: string; platform?: NodeJS.Platform; arch?: string; home?: string;
  appData?: string; resources?: string; lock: ReleaseLock }): Runtime
