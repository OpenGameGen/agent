import { expect,it } from 'vitest'
import { harness, declare } from '../../../packages/preset/agent-preset-registry/tests/harness.ts'
import Skills from '@deepseek-ai/dsh-skill'
import * as presets from '../src/engine-presets.ts'
it('loads all three declared engines from a live Standard definition without changing Standard',async()=>{
  const ctx=await harness()
  ctx.baseUrl=new URL('../src/',import.meta.url).href
  try {
    await ctx.plugin(Skills)
    await declare(ctx,{ id:'standard',plugins:[] })
    await ctx.plugin(presets)
    const roster=await ctx.agentPresets.list()
    expect(roster.filter(p=>['threejs','godot','general'].includes(p.id)).map(p=>({ id:p.id,broken:p.broken }))).toEqual([{ id:'general',broken:undefined },{ id:'godot',broken:undefined },{ id:'threejs',broken:undefined }])
    expect((await ctx.agentPresets.readDocument('standard')).content).toBe('[]\n')
    expect((await ctx.agentPresets.readDocument('general')).content).toContain('engine: general')
  }finally{await ctx.fiber.dispose()}
})
