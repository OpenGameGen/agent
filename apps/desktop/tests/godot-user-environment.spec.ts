import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { seatbeltProfileArgs } from '../../../packages/sandbox/sandbox-local/src/profiles.ts'
import { projectEnvironment, engineEnvironment } from '../resources/godot/user-environment.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function root() { const path = await realpath(await mkdtemp(join(tmpdir(), 'godot-user-'))); roots.push(path); return path }

it.each(['darwin', 'win32'] as const)('isolates child %s user directories and discovers the existing managed templates', async (platform) => {
  const project = await root()
  const templates = join(await root(), '4.6.stable')
  await mkdir(templates)
  const before = { ...process.env }
  const env = await projectEnvironment(project, templates, platform)
  expect(process.env).toEqual(before)
  expect(env.HOME).toBe(join(project, '.godot', 'opengame-user'))
  expect(env.USERPROFILE).toBe(env.HOME)
  const data = platform === 'darwin' ? join(env.HOME!, 'Library', 'Application Support') : env.APPDATA!
  expect(await realpath(join(data, 'Godot', 'export_templates', '4.6.stable'))).toBe(templates)
  expect(await projectEnvironment(project, templates, platform)).toEqual(env)
})

it('rejects a project cache linked outside the workspace', async () => {
  const project = await root()
  const outside = await root()
  await symlink(outside, join(project, '.godot'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(projectEnvironment(project, undefined)).rejects.toThrow('inside the project')
})

const engine = '/Applications/Godot.app/Contents/MacOS/Godot'
it.skipIf(process.platform !== 'darwin' || spawnSync(engine, ['--version']).status !== 0)('checks, runs and exports a real project under standard workspace-write', { timeout: 60000 }, async () => {
  const project = await root()
  await cp(new URL('./fixtures/godot-project/', import.meta.url), project, { recursive: true })
  const cli = new URL('../resources/godot/cli.mjs', import.meta.url).href
  const templates = join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates', '4.6.stable')
  const runner = `import { projectCommand } from ${JSON.stringify(cli)};
    const runtime = { executable: ${JSON.stringify(engine)}, templates: ${JSON.stringify(templates)},
      ensureEngine: async () => ${JSON.stringify(engine)}, ensureTemplates: async () => { throw new Error('pack export does not need template installation') } };
    process.exitCode = await projectCommand(JSON.parse(process.argv[1]), runtime);`
  for (const args of [['check', project], ['run', project, '--headless', '--quit-after', '3'], ['export', project, 'macOS', join(project, 'game.pck'), '--pack']]) {
    const result = spawnSync('sandbox-exec', [...seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: project }), '--', process.execPath, '--input-type=module', '-e', runner, JSON.stringify(args)], { encoding: 'utf8', timeout: 30000 })
    expect(result.status, (result.stdout ?? '') + (result.stderr ?? '')).toBe(0)
    if (args[0] === 'run') expect(result.stdout).toContain('OPENGAME_GODOT_SMOKE_READY')
  }
  expect((await stat(join(project, 'game.pck'))).size).toBeGreaterThan(0)
})

it('rejects an existing nested user directory link before writing outside the project', async () => {
  const project = await root()
  const outside = await root()
  const home = join(project, '.godot', 'opengame-user')
  await mkdir(home, { recursive: true })
  await symlink(outside, join(home, 'Library'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(projectEnvironment(project, undefined, 'darwin')).rejects.toThrow('inside the project')
  await expect(stat(join(outside, 'Application Support'))).rejects.toThrow()
})
it('leaves version/help commands read-only and resolves relative native project paths', async () => {
  const workspace = await root()
  const project = join(workspace, 'game')
  await mkdir(project)
  await writeFile(join(project, 'project.godot'), 'config_version=5')
  for (const args of [['--version'], ['--help'], ['-h']]) expect(await engineEnvironment(args, undefined, project)).toBe(process.env)
  await expect(stat(join(project, '.godot'))).rejects.toThrow()
  const env = await engineEnvironment(['--path', 'game'], undefined, workspace)
  expect(env.HOME).toBe(join(project, '.godot', 'opengame-user'))
  expect((await engineEnvironment(['game/project.godot'], undefined, workspace)).HOME).toBe(env.HOME)
  expect(await engineEnvironment(['--', '--path', 'game'], undefined, workspace)).toBe(process.env)
})
