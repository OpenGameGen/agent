/** Child-only project environment; never changes the agent or parent process environment. */
export function projectEnvironment(project: string, templates: string | undefined, platform?: NodeJS.Platform): Promise<NodeJS.ProcessEnv>
export function engineEnvironment(args: string[], templates: string | undefined, cwd?: string): Promise<NodeJS.ProcessEnv>
