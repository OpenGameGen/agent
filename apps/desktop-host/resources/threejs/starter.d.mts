/** Create a pinned Three.js project within an existing workspace. */
export function createProject(options: { workspace: string; project: string; title?: string }): Promise<{ project: string; engine: 'threejs'; validation: string; files: { path: string; sha256: string }[]; next: string[] }>;
