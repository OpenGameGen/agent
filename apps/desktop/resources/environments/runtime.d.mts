/** Trusted fixed-release metadata. */
export interface Asset { name: string; url: string; mirrors?: string[]; sha256: string; size: number }
/** Product release policy. */
export interface EnvironmentLock {
  blender: { version: string; assets: Record<string, Asset> }
  npm: { version: string; asset: Asset }
}
/** Locations selected by the desktop shell. */
export interface ManagerOptions {
  root: string; primaryRuntime: string; godotRoot: string; godotResources: string; resources: string; lock: EnvironmentLock
  platform?: NodeJS.Platform; arch?: string
}
/** One runtime's installation facts; installed is not a health assertion. */
export interface RuntimeEntry { version: string; executable: string; installed: boolean; source: string }
/** Read-only inventory. */
export interface EnvironmentStatus {
  node: RuntimeEntry; python: RuntimeEntry; blender: RuntimeEntry; godot: RuntimeEntry; templates: RuntimeEntry
  packageManagers: { pnpm: string; npm: string; npmInstalled: boolean }
}
/** Executable-probe outcome. */
export interface Health { healthy: boolean; error?: string; version?: string; executable?: string }
/** Unified runtime operations. */
export interface EnvironmentManager {
  node: string; python: string; pnpm: string; npm: string
  status(): Promise<EnvironmentStatus>
  doctor(kind: string): Promise<Record<string, Health>>
  ensure(kind: string, repair?: boolean): Promise<EnvironmentStatus>
  prepareProject(project: string, kinds: string[]): Promise<Record<string, string | number | undefined>>
  launchBlender(args: string[]): Promise<number>
  launchNpm(args: string[], npx?: boolean): Promise<number>
}
export function createEnvironmentManager(options: ManagerOptions): EnvironmentManager
export function downloadAsset(asset: Asset, root: string): Promise<string>
export function withInstallLock<T>(root: string, operation: () => Promise<T>): Promise<T>
