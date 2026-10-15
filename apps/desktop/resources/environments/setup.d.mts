import type { ManagerOptions } from './runtime.mjs'
/** Trusted launcher paths; optional user home selects the official Godot template directory. */
export type CreationEnvironmentConfig = Omit<ManagerOptions, 'lock'> & { godotHome?: string }
/** One checked or prepared dependency. */
export interface SetupStage {
  target: 'node' | 'python' | 'godot' | 'blender' | 'templates'
  phase: 'checking' | 'installing' | 'reusing' | 'ready'
  reused?: boolean
}
/** Check and prepare fixed dependencies before Desktop starts its profile. */
export function prepareCreationEnvironment(config: CreationEnvironmentConfig, notify: (stage: SetupStage) => void): Promise<SetupStage[]>

export function checkCreationEnvironment(config: CreationEnvironmentConfig): Promise<void>
