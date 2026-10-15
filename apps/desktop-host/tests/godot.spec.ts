import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import * as desktopGodot from '../src/godot.ts'

it('loads the Godot workflow through a real profile composition and removes it on disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-godot-skill-'))
  const ctx = new Context()
  try {
    const nodeDirectory = join(root, 'dependencies', 'node', 'bin')
    await mkdir(nodeDirectory, { recursive: true })
    if (process.platform === 'win32') await copyFile(process.execPath, join(nodeDirectory, 'node.exe'))
    else await symlink(process.execPath, join(nodeDirectory, 'node'))
    await writeFile(join(root, 'cli.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync(new URL("./args.json",import.meta.url),JSON.stringify(process.argv.slice(2)));')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins['test-godot-skills'] = SkillRegistry
    ctx.loader.builtins['test-godot-agents'] = AgentRegistry
    ctx.loader.builtins['test-godot-system'] = SystemPrompt
    ctx.loader.builtins['test-godot-tools'] = ToolRuntime
    ctx.loader.builtins['test-godot-subprocess'] = LocalSubprocessRuntime
    ctx.loader.builtins['test-godot-policy'] = SandboxPolicy
    ctx.loader.builtins['test-godot-projections'] = SessionProjections
    ctx.loader.builtins['test-godot-sandbox'] = LocalSandbox
    ctx.loader.builtins['test-godot-workflow'] = desktopGodot
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: cordis:test-godot-agents', '- name: cordis:test-godot-system', '- name: cordis:test-godot-tools',
      '- name: cordis:test-godot-projections', '- name: cordis:test-godot-policy', '- name: cordis:test-godot-sandbox',
      '- name: cordis:test-godot-subprocess', '- name: cordis:test-godot-skills', '- name: cordis:test-godot-workflow',
      '  config:', '    worker: { idleMs: 60000, requestMs: 30000, maxBytes: 65536 }', `    root: ${JSON.stringify(root)}`, `    resources: ${JSON.stringify(root)}`,
      `    primaryRuntime: ${JSON.stringify(root)}`, '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['godot-game-development'])
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('godot_resource_create')
    await expect(JSON.stringify(ctx.tools.schemas(), null, 2)).toMatchFileSnapshot('./expected/godot-tools.json')
    const generation = (await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'product-godot-generation')?.text
    expect(generation).toContain('Godot game generation agent')
    await expect(generation).toMatchFileSnapshot('./expected/godot-prompt.txt')
    const prepared = await ctx.tools.execute({
      callId: ToolCallId('godot-prepare'), name: 'load_godot_runtime', arguments: { export_templates: true }, signal: new AbortController().signal,
    })
    expect(prepared.isError, JSON.stringify(prepared.content)).toBe(false)
    const argumentsPassed = JSON.parse(await readFile(join(root, 'args.json'), 'utf8')) as string[]
    expect(argumentsPassed.slice(-4)).toEqual(['--mode', 'project', 'install', '--templates'])
    const refused = await ctx.tools.execute({
      callId: ToolCallId('godot-refuse-project'), name: 'load_godot_runtime', arguments: { export_templates: '--script evil.gd' }, signal: new AbortController().signal,
    })
    expect(refused.isError).toBe(true)
    const skill = await ctx.skills.get('godot-game-development')
    expect(skill?.content).toContain('godot-project check')
    await expect(skill?.content).toMatchFileSnapshot('./expected/godot-skill.txt')
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:test-godot-workflow')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(ctx.tools.schemas()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'product-godot-generation')).toBe(false)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
