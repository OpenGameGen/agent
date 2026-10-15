import { mkdtemp, readFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProject } from '../resources/threejs/starter.mjs'
it('creates local pinned dependencies and observable playable source; preserves existing files',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'three-starter-'))
  try{
    const project=join(workspace,'game');const result=await createProject({ workspace,project,title:'<Game>' })
    expect(result.files).toHaveLength(6)
    expect((JSON.parse(await readFile(join(project,'package.json'),'utf8')) as { dependencies: { three: string } }).dependencies.three).toBe('0.180.0')
    expect(await readFile(join(project,'index.html'),'utf8')).toContain('&lt;Game&gt;')
    const source=await readFile(join(project,'src/main.js'),'utf8');expect(source).toContain('window.__game');expect(source).toContain("state.status='won'");expect(source).toContain("state.status='lost'")
    await expect(createProject({ workspace,project })).rejects.toThrow('empty')
    await expect(createProject({ workspace,project:join(workspace,'..','escaped') })).rejects.toThrow('child')
    await mkdir(join(workspace,'empty'));await symlink(join(workspace,'empty'),join(workspace,'link'))
    await expect(createProject({ workspace,project:join(workspace,'link') })).rejects.toThrow('Symlink')
  }finally{await rm(workspace,{ recursive:true,force:true })}
})
