export const source: string
/** Text template; createProject additionally verifies/copies the bundled font and license. */
export function template(dimension: string, title: string): Record<string, string>
export function createProject(options: { workspace: string; project: string; dimension: string; title?: string }): Promise<{
  project: string; source: string; dimension: string; gameplay_implemented: boolean; main_scene: string;
  files: { path: string; sha256: string }[]; manifest: string; validation: { engine_check: string; runtime_smoke: string; gameplay: string };
  next_steps: ({ tool: string } | { command: string; args: string[] })[]; note: string
}>
