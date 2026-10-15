import { mkdir, readdir, realpath, writeFile, lstat } from 'node:fs/promises'
import { relative, resolve, sep, join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
export async function createProject({ workspace, project, title = 'Three.js Game' }) {
  if (!isAbsolute(project) || !isAbsolute(workspace)) throw new Error('Absolute workspace and project required')
  if (typeof title !== 'string' || title.trim().length < 1 || title.length > 80) throw new Error('Title must contain 1–80 characters')
  const root = await realpath(workspace)
  const parent = await realpath(resolve(project, '..'))
  const destination = join(parent, project.split(/[\\/]/).at(-1))
  const inside = relative(root, destination)
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) throw new Error('Project must be a child of workspace')
  try {
    if ((await lstat(project)).isSymbolicLink() || (await realpath(project)) !== destination) throw new Error('Symlink project is not allowed')
    if ((await readdir(project)).length) throw new Error('Project must be empty')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const files = {
    'package.json': JSON.stringify({ name: 'threejs-game', version: '0.1.0', private: true, type: 'module', scripts: { dev: 'vite --host 127.0.0.1', build: 'vite build', preview: 'vite preview --host 127.0.0.1' }, dependencies: { three: '0.180.0' }, devDependencies: { vite: '6.4.3' } }, null, 2)+'\n',
    'index.html': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head><body><div id="hud"></div><button id="restart">重新开始 / Restart</button><script type="module" src="/src/main.js"></script></body></html>`,
    'src/style.css': 'body{margin:0;overflow:hidden;background:#101828;font-family:system-ui;color:white}canvas{display:block}#hud{position:fixed;top:16px;left:16px;padding:12px;background:#0008;border-radius:12px;pointer-events:none}#restart{position:fixed;right:16px;top:16px;padding:10px;border:0;border-radius:8px;cursor:pointer}',
    'src/main.js': `import * as THREE from 'three';
import './style.css';
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101828);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100); camera.position.set(0,12,14); camera.lookAt(0,0,0);
const renderer = new THREE.WebGLRenderer({ antialias: true }); document.body.append(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 3));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(16,16),new THREE.MeshStandardMaterial({color:0x243b53})); floor.rotation.x=-Math.PI/2; scene.add(floor);
const player = new THREE.Mesh(new THREE.BoxGeometry(0.8,0.8,0.8),new THREE.MeshStandardMaterial({color:0x58d5ff})); player.position.y=0.4; scene.add(player);
const coinGeometry=new THREE.SphereGeometry(0.3,16,12), coinMaterial=new THREE.MeshStandardMaterial({color:0xffd166});
const locations=[[-5,-5],[5,-5],[-5,5],[5,5],[0,-3]],coins=[];
const state=window.__game={score:0,target:5,status:'playing',elapsed:0,player:{x:0,z:0}};
function reset(){ for(const coin of coins)scene.remove(coin); coins.length=0; for(const [x,z] of locations){const coin=new THREE.Mesh(coinGeometry,coinMaterial);coin.position.set(x,0.4,z);scene.add(coin);coins.push(coin)} player.position.set(0,0.4,0); Object.assign(state,{score:0,status:'playing',elapsed:0,player:{x:0,z:0}}); }
const keys=new Set(); addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key))e.preventDefault();keys.add(e.key.toLowerCase());if(e.key.toLowerCase()==='r')reset()});addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));addEventListener('blur',()=>keys.clear());document.querySelector('#restart').onclick=reset;
function resize(){camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight)} addEventListener('resize',resize);resize();reset();
let previous=performance.now(); const hud=document.querySelector('#hud');
renderer.setAnimationLoop(now=>{const dt=Math.min((now-previous)/1000,0.05);previous=now;if(state.status==='playing'){state.elapsed+=dt; const dx=Number(keys.has('d')||keys.has('arrowright'))-Number(keys.has('a')||keys.has('arrowleft')); const dz=Number(keys.has('s')||keys.has('arrowdown'))-Number(keys.has('w')||keys.has('arrowup')); const length=Math.hypot(dx,dz)||1;player.position.x=THREE.MathUtils.clamp(player.position.x+dx/length*5*dt,-7.5,7.5);player.position.z=THREE.MathUtils.clamp(player.position.z+dz/length*5*dt,-7.5,7.5);for(let i=coins.length-1;i>=0;i--){if(player.position.distanceTo(coins[i].position)<0.85){scene.remove(coins[i]);coins.splice(i,1);state.score++}}if(state.score===state.target)state.status='won';else if(state.elapsed>=60)state.status='lost';}state.player={x:player.position.x,z:player.position.z};hud.textContent='WASD / 方向键移动 · 收集金币 '+state.score+'/'+state.target+' · '+Math.max(0,60-Math.floor(state.elapsed))+'s · '+state.status+' · R 重开';renderer.render(scene,camera)});
`,
    '.gitignore': 'node_modules/\ndist/\n',
    'README.md': '# '+title+'\n\nRun pnpm install, pnpm dev, and open the printed localhost URL. WASD/arrows move; collect five coins in 60 seconds. R or Restart resets. Run pnpm build for the distributable dist directory. This is a small playable starter, not the requested finished game. Browser validation can inspect window.__game.\n',
  }
  await mkdir(join(destination,'src'),{recursive:true})
  const manifest=[]
  for(const [name,content] of Object.entries(files)){await writeFile(join(destination,name),content,{flag:'wx'});manifest.push({path:name,sha256:createHash('sha256').update(content).digest('hex')})}
  return {project:destination,engine:'threejs',files:manifest,next:['pnpm install','pnpm dev','pnpm build'],validation:'Use real browser inputs and inspect window.__game; starter generation is not gameplay validation.'}
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await createProject(JSON.parse(process.argv[2])))) } catch(error){console.error(error.message);process.exitCode=1}
}
