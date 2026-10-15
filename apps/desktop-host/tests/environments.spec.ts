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
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import * as environments from '../src/environments.ts'

it('loads runtime tools through the profile Loader, forwards trusted argv, logs health diagnostics and disposes registrations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop environments '))
  const ctx = new Context()
  try {
    const bin = join(root, 'dependencies', 'node', 'bin')
    await mkdir(bin, { recursive: true })
    if (process.platform === 'win32') await copyFile(process.execPath, join(bin, 'node.exe'))
    else await symlink(process.execPath, join(bin, 'node'))
    await writeFile(join(root, 'cli.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync(new URL('./args.json',import.meta.url),JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({blender:{healthy:false,error:'Not installed'}}));
if(process.argv.includes('doctor')) process.exitCode=1;
`)
    ctx.baseUrl = pathToFileURL(root).href+'/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins['test-agents'] = AgentRegistry
    ctx.loader.builtins['test-tools'] = ToolRuntime
    ctx.loader.builtins['test-system'] = SystemPrompt
    ctx.loader.builtins['test-skills'] = SkillRegistry
    ctx.loader.builtins['test-subprocess'] = LocalSubprocessRuntime
    ctx.loader.builtins['test-environments'] = environments
    const file = join(root, 'cordis.yml')
    await writeFile(file, ['- name: cordis:test-agents', '- name: cordis:test-system', '- name: cordis:test-tools', '- name: cordis:test-skills',
      '- name: cordis:test-subprocess', '- name: cordis:test-environments', '  config:', '    timeoutMs: 2100000',
      `    launcherConfig: ${JSON.stringify(join(root, 'launcher.json'))}`, `    resources: ${JSON.stringify(root)}`,
      `    primaryRuntime: ${JSON.stringify(root)}`, ''].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['manage_runtime_environment'])
    await expect(JSON.stringify(ctx.tools.schemas(), null, 2)).toMatchFileSnapshot('./expected/environment-tools.json')
    await expect((await ctx.skills.get('managed-development-environments'))?.content).toMatchFileSnapshot('./expected/environment-skill.txt')
    const result = await ctx.tools.execute({ callId: ToolCallId('environment-doctor'), name: 'manage_runtime_environment',
      arguments: { action: 'doctor', runtime: 'blender' }, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Not installed')
    const argv = JSON.parse(await readFile(join(root, 'args.json'), 'utf8')) as string[]
    expect(argv).toEqual(['--config', join(root, 'launcher.json'), '--mode', 'env', 'doctor', 'blender'])
    const refused = await ctx.tools.execute({ callId: ToolCallId('environment-refuse'), name: 'manage_runtime_environment',
      arguments: { action: 'exec', runtime: 'arbitrary-url' }, signal: new AbortController().signal })
    expect(refused.isError).toBe(true)
    const plugin = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:test-environments')
    await plugin?.fiber?.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
