/** Read-only bounded executable discovery. */
export function findExternalRuntime(kind: 'godot' | 'blender', version: string, options?: {
  platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; candidates?: string[]; excludedRoots?: string[];
  probe?: (file: string, args: string[]) => Promise<string>;
}): Promise<string | undefined>
