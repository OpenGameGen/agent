import { Context } from '@deepseek-ai/cordis'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { expect, it } from 'vitest'
import * as engine from '../src/engine-agent.ts'

it('isolates engine guidance and masks without changing the global/default agent', async()=>{
  const ctx=new Context()
  try {
    await ctx.plugin(Tools);await ctx.plugin(SystemPrompt);await ctx.plugin(Skills)
    for(const name of ['godot_project_create','game_start','threejs_project_create','webgame_start','read'])ctx.tools.register(defineContentToolFixture({ name,description:name,parameters:{},async execute(){return [{ type:'text',text:'ok' }]} }))
    for(const name of ['product-godot-generation','product-game-validation','product-game-tool-groups'])ctx.systemPrompt.section({ name,order:100,text:'Godot-only '+name })
    const keys=[{},{},{}]
    const scopes=keys.map(key=>createScope(ctx,key))
    for(const [i,mode] of ['threejs','godot','general'].entries())await scopes[i]!.ctx.plugin(engine,{ engine:mode as engine.Config['engine'] })
    const names=(i:number)=>ctx.tools.schemas(keys[i]).map(t=>t.name)
    expect(names(0)).toContain('threejs_project_create');expect(names(0)).not.toContain('game_start');expect(names(0)).toContain('read')
    expect(names(1)).toContain('game_start');expect(names(1)).not.toContain('threejs_project_create')
    expect(names(2)).toEqual(['godot_project_create', 'game_start', 'threejs_project_create', 'webgame_start', 'read'])
    expect(names(1)).not.toContain('webgame_start')
    const catalog = await ctx.skills.list({ scope: keys[0] })
    expect(catalog.find(skill => skill.name === 'threejs-game-development')?.invocation.modelInvocable).toBe(true)
    expect(catalog.find(skill => skill.name === 'godot-game-development')?.invocation.modelInvocable).toBe(false)
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope:keys[0]! }))).toContain('Three.js')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope:keys[0]! }))).not.toContain('Godot-only')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope:keys[2]! }))).not.toContain('Godot-only')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope:keys[2]! }))).toContain(engine.GENERAL_GUIDANCE)
    const generalSkills = await ctx.skills.list({ scope: keys[2] })
    expect(generalSkills.find(skill => skill.name === 'threejs-game-development')?.invocation.modelInvocable).toBe(true)
    expect(generalSkills.find(skill => skill.name === 'unity-game-development')?.invocation.modelInvocable).toBe(true)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Godot-only')
    ctx.tools.register(defineContentToolFixture({ name:'godot_late',description:'late',parameters:{},async execute(){return [{ type:'text',text:'ok' }]} }))
    expect(names(0)).not.toContain('godot_late');expect(names(1)).toContain('godot_late')
    for(const scope of scopes)await scope.dispose()
    expect(ctx.tools.schemas().map(t=>t.name)).toContain('game_start')
  }finally{await ctx.fiber.dispose()}
})
