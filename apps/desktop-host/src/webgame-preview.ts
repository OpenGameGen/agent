/** Fixed local web game preview operations through the product Desktop browser. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createServer, type Server } from 'node:http'
import { readFile, realpath, mkdir, writeFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WEBGAME_OBSERVER } from './webgame-observer.ts'
import { createGameTransport, type GameTransport } from './game-transport.ts'
export const name = 'desktop-webgame-preview'
export const inject = ['tools', 'sandboxPolicy', 'agents']
interface Run { id: string; sessionId: string; root: string; workspace: string; url: string; server: Server }
const mime: Record<string, string> = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.wasm':'application/wasm', '.glb':'model/gltf-binary', '.gltf':'model/gltf+json', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav' }
function contained(root: string, path: string): boolean { const rel=relative(root,path);return rel==='' || (rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)) }
/** Exported for boundary tests; only files within the selected local game root are served. */
export async function startWebGameServer(root: string, id: string): Promise<{ server:Server;url:string }> {
  root = await realpath(root)
  const server=createServer((request,response)=>{void (async()=>{
    try{
      const incoming = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (incoming.pathname === '/__webgame_observer.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(WEBGAME_OBSERVER)
        return
      }
      let pathname=decodeURIComponent(new URL(request.url??'/', 'http://127.0.0.1').pathname)
      const prefix='/game/'+id+'/'
      if(pathname.startsWith(prefix))pathname=pathname.slice(prefix.length)
      else pathname=pathname.replace(/^\//,'')
      if(pathname===''||pathname.endsWith('/'))pathname+='index.html'
      if(pathname.split('/').some(part=>part.startsWith('.')))throw new Error('Hidden or traversal path')
      const file=await realpath(join(root,pathname))
      if(!contained(root,file)||!mime[extname(file).toLowerCase()])throw new Error('File outside preview or unsupported type')
      if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('Preview asset exceeds limit')
      const media = mime[extname(file).toLowerCase()]
      if (media === undefined) throw new Error('Unsupported preview type')
      response.setHeader('Content-Type', media)
      response.setHeader('Cache-Control','no-store')
      response.setHeader('X-Content-Type-Options','nosniff')
      const content = await readFile(file)
      response.end(media === 'text/html'
        ? content.toString().replace(/<head(?:\s[^>]*)?>/i, head => head + '<script src="/__webgame_observer.js"></script>')
        : content)
    }catch{response.writeHead(404);response.end('Not found')}
  })()})
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{ resolve() })})
  const address=server.address();if(address===null||typeof address==='string')throw new Error('Preview server unavailable')
  return { server,url:`http://127.0.0.1:${address.port}/game/${id}/index.html` }
}
export function apply(ctx:Context):void { const transport=createGameTransport('webgame:');ctx.effect(()=>()=>{ transport.dispose() });registerWebGamePreview(ctx,transport.request) }
/** Register per-session preview tools; tests can supply the documented transport seam. */
export function registerWebGamePreview(ctx:Context, transport:GameTransport):void {
  const runs = new Map<string, Run>()
  const tails = new Map<string, Promise<unknown>>()
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.agent || !exec.name.startsWith('webgame_')) return next()
    const id = exec.agent.id
    const previous = tails.get(id) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => { exec.signal.throwIfAborted(); return next() })
    tails.set(id, task)
    try { return await task } finally { if (tails.get(id) === task) tails.delete(id) }
  })
  const close=async(run:Run,signal:AbortSignal)=>{
    try{await transport('stop',{ runId:run.id,sessionId:run.sessionId },signal)}finally{run.server.closeAllConnections();await new Promise<void>(resolve=>run.server.close(()=>{ resolve() }));runs.delete(run.sessionId)}
  }
  ctx.on('agent/disposed', ({ agent }) => { const run = runs.get(agent.id); if (run) void close(run, AbortSignal.timeout(3000)).catch(() => {}) })
  ctx.effect(()=>async()=>{await Promise.allSettled([...runs.values()].map(run=>close(run,AbortSignal.timeout(3000))))})
  const output={ schema:{ type:'string' as const },render:(_args:object,value:string)=>[{ type:'text' as const,text:value }] }
  ctx.tools.register(defineTool({ name:'webgame_start',description:'Preview an already-built local browser game (Three.js/Vite dist directory or plain HTML directory with index.html) in the desktop right panel. Serves only that workspace directory on loopback, no npm install/build. Replaces this task preview. No Godot needed. Publish a small JSON-safe window.__game object with status/score/player for state assertions. Use webgame_key/state/errors/screenshot to test; source changes require rebuilding and restarting.',parameters:{ directory:{ type:'string',required:true } },output,timeoutMs:90000,presentCall:()=>({ card:'generic',title:'Preview web game',kind:'execute' }),async execute(args,exec){
    if(!exec.agent)throw new Error('Preview requires an active task');exec.signal.throwIfAborted()
    const policy=ctx.sandboxPolicy.resolve({ session:exec.agent.session });const workspace=await realpath(policy.workspaceRoot)
    const root=await realpath(args.directory);if(!contained(workspace,root))throw new Error('Preview must be inside the workspace')
    await readFile(join(root,'index.html'));const sessionId=exec.agent.id;const old=runs.get(sessionId);if(old)await close(old,exec.signal)
    const id = randomUUID()
    const served = await startWebGameServer(root, id)
    const run = { id, sessionId, root, workspace, ...served }
    runs.set(sessionId, run)
    try{await transport('open',{ runId:id,sessionId,url:served.url,isolation:true },exec.signal);return JSON.stringify({ url:served.url,directory:root,ready:true })}
    catch(error){await close(run,AbortSignal.timeout(3000)).catch(()=>{});throw error}
  } }))
  ctx.tools.register(defineTool({
    name: 'webgame_test',
    description: 'Run a bounded JSON array of steps without model delays. Each step is {key:"r",duration_ms:50}, {key:"w",duration_ms:300}, {assert:{path:"score",expected:3}}, {assert:{path:"status",expected:"won"}}, or {wait_ms:100}. Assertion paths refer to window.__game. Start with restart input. Maximum 30 steps and 30 seconds of total requested waiting/input. Returns every observed assertion and stops at the first mismatch. This uses real browser input, never mutates game state through JavaScript.',
    parameters: { steps: { type: 'string', required: true } }, output, timeoutMs: 90000,
    presentCall: () => ({ card: 'generic', title: 'Test web game', kind: 'execute' }),
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Preview requires an active task')
      const run = runs.get(exec.agent.id)
      if (!run) throw new Error('Call webgame_start first')
      const steps: unknown = JSON.parse(args.steps)
      if (!Array.isArray(steps) || steps.length < 1 || steps.length > 30) throw new Error('Expected 1–30 test steps')
      let duration = 0
      let assertions = 0
      const results: unknown[] = []
      const sequence: readonly unknown[] = steps
      for (const step of sequence) {
        if (typeof step !== 'object' || step === null || Array.isArray(step)) throw new Error('Invalid test step')
        exec.signal.throwIfAborted()
        if ('freeze' in step && step.freeze === true) {
          results.push(await transport('freeze', { runId:run.id,sessionId:run.sessionId },exec.signal))
        } else if ('thaw' in step && step.thaw === true) {
          results.push(await transport('thaw', { runId:run.id,sessionId:run.sessionId },exec.signal))
        } else if ('key' in step && typeof step.key === 'string') {
          const ms = 'duration_ms' in step ? step.duration_ms : 80
          if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 10000) throw new Error('Invalid key duration')
          duration += ms
          if (duration > 30000) throw new Error('Test duration exceeds 30 seconds')
          results.push(await transport('key', { key: step.key, duration_ms: ms, runId: run.id, sessionId: run.sessionId }, exec.signal))
        } else if ('wait_ms' in step && typeof step.wait_ms === 'number') {
          const ms = step.wait_ms
          if (!Number.isFinite(ms) || ms < 0 || (duration += ms) > 30000) throw new Error('Invalid test wait')
          await new Promise<void>(resolve => setTimeout(resolve, ms))
        } else if ('assert' in step && typeof step.assert === 'object' && step.assert !== null) {
          const spec = step.assert
          if (!('path' in spec) || typeof spec.path !== 'string' || !('expected' in spec)) throw new Error('Invalid assertion')
          const result = await transport('state', { runId: run.id, sessionId: run.sessionId }, exec.signal)
          let actual: unknown = typeof result === 'object' && result !== null && 'state' in result ? result.state : undefined
          for (const key of spec.path.split('.')) {
            actual = typeof actual === 'object' && actual !== null && Object.hasOwn(actual, key)
              ? (actual as Record<string, unknown>)[key] : undefined
          }
          assertions += 1
          const passed = JSON.stringify(actual) === JSON.stringify(spec.expected)
          results.push({ path: spec.path, expected: spec.expected, actual, passed })
          if (!passed) return JSON.stringify({ passed: false, results })
        } else throw new Error('Unknown web game step')
      }
      return JSON.stringify({ passed: assertions > 0 ? true : null, verified: assertions > 0, assertions, results,
        note: assertions > 0 ? 'Only the requested state assertions were validated.' : 'Input delivery alone is not gameplay verification.' })
    },
  }))
  const tools=[['webgame_freeze','freeze','Pause requestAnimationFrame callbacks and their timestamps for screenshot planning. Does not pause timers, Date.now or network; state may continue changing in games using those.'],['webgame_thaw','thaw','Resume the paused animation frame clock without including planning time in frame timestamps.'],['webgame_state','state','Observe window.__game JSON state (or rendered text if absent).'],['webgame_errors','errors','Observe captured JavaScript errors; also use build checks and screenshots.'],['webgame_key','key','Hold one physical key, then inspect state; delivery alone is not success.'],['webgame_click','click','Click viewport CSS coordinates, then inspect state.'],['webgame_screenshot','screenshot','Save a historical PNG inside the workspace; use read_image to inspect it.'],['webgame_stop','stop','Close this task preview and release its local server.']] as const
  for(const [name,operation,description] of tools)ctx.tools.register(defineTool({ name,description,parameters:operation==='key'?{ key:{ type:'string',required:true },duration_ms:{ type:'number' } }:operation==='click'?{ x:{ type:'number',required:true },y:{ type:'number',required:true } }:{},output,timeoutMs:90000,presentCall:()=>({ card:'generic',title:name,kind:'read' }),async execute(args,exec){
    if(!exec.agent)throw new Error('Preview requires an active task');const run=runs.get(exec.agent.id);if(!run)throw new Error('Call webgame_start first')
    if(operation==='stop'){await close(run,exec.signal);return JSON.stringify({ stopped:true })}
    const value=await transport(operation,{ ...args,runId:run.id,sessionId:run.sessionId },exec.signal)
    if(operation==='screenshot'){
      const policy=ctx.sandboxPolicy.resolve({ session:exec.agent.session });if(policy.mode==='read-only')throw new Error('Saving evidence requires workspace-write')
      if(typeof value!=='object'||value===null||!('png'in value)||typeof value.png!=='string'||value.png.length>24*1024*1024)throw new Error('Invalid screenshot')
      const directory=join(run.workspace,'.webgame-evidence');await mkdir(directory,{ recursive:true });const resolved = await realpath(directory);if(!contained(run.workspace,resolved))throw new Error('Evidence directory escaped workspace');const path=join(resolved,randomUUID()+'.png');await writeFile(path,Buffer.from(value.png,'base64'),{ flag:'wx',mode:0o600 });return JSON.stringify({ path,captured_at:new Date().toISOString(),historical:true })
    }
    return JSON.stringify({ result:value,observed_at:new Date().toISOString() })
  } }))
}
