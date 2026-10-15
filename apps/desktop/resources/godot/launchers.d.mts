/** Generate managed commands from explicit runtime interpreters, then verify access. */
export function ensureLaunchers(options: { root: string; node: string; python: string; cli: string; platform?: NodeJS.Platform }): Promise<string>
