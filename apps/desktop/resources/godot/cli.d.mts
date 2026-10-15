/** Project CLI contracts for isolated behavior checks. */
import type { Runtime } from './runtime.mjs'
export function projectPath(directory: string | undefined): Promise<string>
export function scriptsIn(root: string): Promise<string[]>
export function projectCommand(args: string[], runtime: Runtime): Promise<number>
export function main(args: string[]): Promise<number>
/** Compare the canonical executable entry to this CLI module without running it. */
export function isDirectEntry(entry?: string): Promise<boolean>

export function rawImportProjectConfig(args: string[]): Promise<string | undefined>
