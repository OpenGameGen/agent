export const PRODUCT: Readonly<{ name: 'OpenGameGen'; appId: 'com.opengamegen.desktop'; scheme: 'opengamegen'; command: 'opengamegen'; artifact: 'opengamegen' }>
export function productAppId(env?: NodeJS.ProcessEnv): string
export function productEnvironment(env?: NodeJS.ProcessEnv, home?: string): NodeJS.ProcessEnv & { DSH_HOME: string; DSH_AGENTS_HOME: string }
export function initializeProductApp(app: { getPath(name: 'appData'): string; setName(name: string): void; setPath(name: 'userData' | 'sessionData' | 'crashDumps', path: string): void; setAppLogsPath(path: string): void }, env?: NodeJS.ProcessEnv): void

export function productRuntimePaths(env?: NodeJS.ProcessEnv, home?: string): { home: string; environments: string; godot: string }
