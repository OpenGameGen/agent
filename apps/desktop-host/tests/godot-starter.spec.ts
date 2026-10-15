import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as starterPlugin from '../src/godot-starter.ts'
import { afterEach, expect, it } from 'vitest'
import { createProject } from '../../desktop/resources/godot/starter.mjs'
import { seatbeltProfileArgs } from '../../../packages/sandbox/sandbox-local/src/profiles.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function workspace() { const path = await realpath(await mkdtemp(join(tmpdir(), 'starter-'))); roots.push(path); return path }

it.each(['2d', '3d'])('creates a versioned %s skeleton with authentic file hashes and no gameplay claims', async (dimension) => {
  const root = await workspace()
  const result = await createProject({ workspace: root, project: join(root, 'game'), dimension, title: 'Test "Game"' })
  expect(result.gameplay_implemented).toBe(false)
  expect(result.validation).toEqual({ engine_check: 'not_run', runtime_smoke: 'not_run', gameplay: 'not_implemented' })
  expect(result.next_steps).toContainEqual({ command: 'godot-project', args: ['check', result.project] })
  expect(result.source).toBe('opengame:blank-project@2')
  expect(await readdir(result.project)).toEqual(['DefaultTheme.tres', 'Main.gd', 'Main.tscn', 'NotoSansSC-OFL.txt', 'NotoSansSC-VariableFont_wght.ttf', 'OpenGameUIFont.gd', 'opengame-starter.json', 'project.godot'])
  for (const file of result.files) expect(createHash('sha256').update(await readFile(join(result.project, file.path))).digest('hex')).toBe(file.sha256)
  expect(await readFile(join(result.project, 'Main.tscn'), 'utf8')).toContain('script = ExtResource("1")')
  expect(await readFile(join(result.project, 'project.godot'), 'utf8')).toContain('run/main_scene="res://Main.tscn"')
})

it('accepts an empty directory, refuses existing content, and allows only one concurrent initializer', async () => {
  const root = await workspace()
  const project = join(root, 'game')
  await mkdir(project)
  const args = { workspace: root, project, dimension: '2d' }
  const results = await Promise.allSettled([createProject(args), createProject(args)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const before = await readFile(join(project, 'Main.gd'))
  await expect(createProject(args)).rejects.toThrow('empty')
  expect(await readFile(join(project, 'Main.gd'))).toEqual(before)
})

it('rejects outside paths, project/ancestor symlinks, missing parents and invalid arguments without writes', async () => {
  const root = await workspace()
  const outside = await workspace()
  await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const project of [outside, root, join(root, 'link'), join(root, 'link', 'child'), join(root, 'missing', 'child')]) {
    await expect(createProject({ workspace: root, project, dimension: '2d' })).rejects.toThrow()
  }
  for (const [dimension, title] of [['4d', 'Game'], ['2d', '\n'], ['3d', 'x'.repeat(81)]]) {
    await expect(createProject({ workspace: root, project: join(root, 'invalid'), dimension: dimension!, title: title! })).rejects.toThrow()
  }
  expect(await readdir(outside)).toEqual([])
  expect(await readdir(root)).toEqual(['link'])
})

const engine = '/Applications/Godot.app/Contents/MacOS/Godot'
it.skipIf(process.platform !== 'darwin' || spawnSync(engine, ['--version']).status !== 0)('creates, checks and inspects both real Godot scenes under workspace-write', { timeout: 60000 }, async () => {
  const root = await workspace()
  const starter = new URL('../../desktop/resources/godot/starter.mjs', import.meta.url).pathname
  const cli = new URL('../../desktop/resources/godot/cli.mjs', import.meta.url).href
  const runner = `import { projectCommand } from ${JSON.stringify(cli)}; process.exitCode = await projectCommand(JSON.parse(process.argv[1]), { executable: ${JSON.stringify(engine)}, ensureEngine: async () => ${JSON.stringify(engine)} });`
  for (const dimension of ['2d', '3d']) {
    const project = join(root, dimension)
    const created = spawnSync('sandbox-exec', [...seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: root }), '--', process.execPath, starter, JSON.stringify({ workspace: root, project, dimension })], { encoding: 'utf8', timeout: 10000 })
    expect(created.status, created.stderr).toBe(0)
    for (const args of [['check', project], ['run', project, '--headless', '--quit-after', '3']]) {
      const result = spawnSync('sandbox-exec', [...seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: root }), '--', process.execPath, '--input-type=module', '-e', runner, JSON.stringify(args)], { encoding: 'utf8', timeout: 25000 })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    }
    await writeFile(join(project, 'inspect.gd'), `extends SceneTree\nfunc _initialize():\n\tcall_deferred("inspect_starter")\nfunc inspect_starter():\n\tvar label = Label.new()\n\troot.add_child(label)\n\tvar font = label.get_theme_font("font")\n\tassert(font != null)\n\tfor glyph in "星际采集开始游戏胜利失败重新 Score Lives 0123456789":\n\t\tassert(font.has_char(glyph.unicode_at(0)))\n\tlabel.free()\n\tvar scene = load(ProjectSettings.get_setting("application/run/main_scene")).instantiate()\n\tassert(scene.get_script() != null)\n\tassert(scene.get_node("Placeholder") != null)\n${dimension === '3d' ? '\tassert(scene.get_node("Camera3D").current)\n\tassert(scene.get_node("DirectionalLight3D") != null)\n' : ''}\tprint("STARTER_STRUCTURE_OK")\n\tscene.free()\n\tquit()\n`)
    const inspect = spawnSync(process.execPath, ['--input-type=module', '-e', runner, JSON.stringify(['run', project, '--headless', '--script', 'res://inspect.gd'])], { encoding: 'utf8', timeout: 10000 })
    expect(inspect.status, inspect.stdout + inspect.stderr).toBe(0)
    expect(inspect.stdout).toContain('STARTER_STRUCTURE_OK')
  }
})

it.skipIf(process.platform !== 'darwin')('loads the independent Cordis tool and respects read-only, cancellation and workspace bounds', async () => {
  const root = await workspace()
  await mkdir(join(root, 'dependencies/node/bin'), { recursive: true })
  await symlink(process.execPath, join(root, 'dependencies/node/bin/node'))
  for (const mode of ['workspace-write', 'read-only']) {
    const ctx = new Context()
    try {
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      Object.assign(ctx.loader.builtins, { include: Include, agents: AgentRegistry, system: SystemPrompt, tools: ToolRuntime,
        projections: SessionProjections, policy: SandboxPolicy, sandbox: LocalSandbox, subprocess: LocalSubprocessRuntime,
        starter: starterPlugin })
      const config = join(root, 'cordis.yml')
      await writeFile(config, [
        '- name: cordis:agents', '- name: cordis:system', '- name: cordis:tools', '- name: cordis:projections', '- name: cordis:policy',
        '  config:', `    mode: ${mode}`, `    workspaceRoot: ${JSON.stringify(root)}`,
        '- name: cordis:sandbox', '- name: cordis:subprocess', '- name: cordis:starter', '  config:',
        `    primaryRuntime: ${JSON.stringify(root)}`,
        `    resources: ${JSON.stringify(fileURLToPath(new URL('../../desktop/resources/godot/', import.meta.url)))}`, '',
      ].join('\n'))
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      let ordinal = 0
      const call = (project: string, signal = new AbortController().signal) => ctx.tools.execute({
        callId: ToolCallId(`starter-${++ordinal}`), name: 'godot_project_create', arguments: { project, dimension: '2d' }, signal,
      })
      const result = await call(join(root, mode))
      expect(result.isError, JSON.stringify(result.content)).toBe(mode === 'read-only')
      const outside = await workspace()
      expect((await call(join(outside, 'escape'))).isError).toBe(true)
      expect(await readdir(outside)).toEqual([])
      const controller = new AbortController()
      controller.abort()
      await call(join(root, 'cancelled'), controller.signal).catch(() => {})
      expect(await readdir(root)).not.toContain('cancelled')
    } finally { await ctx.fiber.dispose() }
  }
})

it.each(['font', 'license'])('rejects corrupted bundled %s bytes before creating any project files', async (asset) => {
  const root = await workspace()
  await mkdir(join(root, 'fonts'))
  const resources = new URL('../../desktop/resources/godot/', import.meta.url)
  await writeFile(join(root, 'starter.mjs'), await readFile(new URL('starter.mjs', resources)))
  await writeFile(join(root, 'fonts', 'metadata.json'), await readFile(new URL('fonts/metadata.json', resources)))
  await writeFile(join(root, 'fonts', 'OFL.txt'), await readFile(new URL('fonts/OFL.txt', resources)))
  await writeFile(join(root, 'fonts', 'NotoSansSC-VariableFont_wght.ttf'),
    asset === 'font' ? 'corrupted font' : await readFile(new URL('fonts/NotoSansSC-VariableFont_wght.ttf', resources)))
  if (asset === 'license') await writeFile(join(root, 'fonts', 'OFL.txt'), 'corrupted license')
  const result = spawnSync(process.execPath, [join(root, 'starter.mjs'), JSON.stringify({
    workspace: root, project: join(root, 'game'), dimension: '2d',
  })], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Bundled font integrity check failed')
  expect(await readdir(root)).not.toContain('game')
})
