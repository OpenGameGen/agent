/** Local diagnostics page; model names and results enter the DOM only as text.
 * @param nonce - Fresh response CSP nonce. @param chinese - Operator locale.
 * @returns Standalone local HTML with no external resources.
 */
export function networkDiagnosticsPage(nonce: string, chinese: boolean): string {
  const copy = chinese ? {
    models: '免费模型通道', images: '免费图片通道', title: '网络检测', intro: '检测应用实际使用的网络。免费模型会发送简短测试请求；生图检测只检查接口，不生成图片。',
    all: '检测全部', cancel: '取消', test: '检测', idle: '未检测', running: '检测中', success: '可用', error: '不可用', cancelled: '已取消',
    name: '通道', status: '结果', detail: '详情', latency: '耗时', time: '检测时间', empty: '免费模型目录尚未就绪，点击检测全部刷新。',
    hint: '接口可达不代表生图已完成。限流不代表网络断开；调整网络或代理后请重新检测。',
  } : {
    models: 'Free model channel', images: 'Free image channel', title: 'Network Diagnostics', intro: 'Test the network used by this app. Free models receive a short test request; image checks do not generate images.',
    all: 'Test all', cancel: 'Cancel', test: 'Test', idle: 'Not tested', running: 'Testing', success: 'Available', error: 'Unavailable', cancelled: 'Cancelled',
    name: 'Channel', status: 'Result', detail: 'Details', latency: 'Duration', time: 'Tested at', empty: 'Free model catalog is not ready. Test all to refresh.',
    hint: 'Endpoint access does not confirm image generation. Rate limits do not mean the network is offline; Retest after changing your network or proxy.',
  }
  const details = chinese ? {
    MODEL_COMPLETED: '通道可用（实际请求已返回文本）', BOTH_IMAGES_AVAILABLE: 'AI Horde 和 Perchance 均可连接', HORDE_AVAILABLE: 'AI Horde 可连接；Perchance 暂不可用', PERCHANCE_AVAILABLE: 'Perchance 可连接；AI Horde 暂不可用', IMAGE_CHANNELS_UNAVAILABLE: '两个图片渠道均不可用，请检查网络和代理', CATALOG_AVAILABLE: '已获取免费模型目录', IMAGE_MODELS_AVAILABLE: '接口可达，有在线生图模型',
    IMAGE_ENDPOINTS_REACHABLE: '网站及生图接口可达（未验证生成）', RATE_LIMIT: '服务限流，请稍后重试', TIMEOUT: '连接或响应超时，检查代理后重试',
    TRANSPORT: '网络连接失败，检查网络和代理', REGION_BLOCKED: '服务限制当前地区', AUTH: '服务拒绝认证', NO_ADAPTER: '免费模型插件未就绪',
    NO_FREE_MODELS: '当前未发现免费模型', NO_IMAGE_WORKERS: '接口可达，但没有在线生图工作节点', EMPTY_RESPONSE: '请求未返回完整文本',
    SERVER: '服务端错误，请稍后重试', CANCELLED: '检测已取消', NETWORK_OR_SERVICE_ERROR: '网络或服务不可用，检查代理后重试',
    PROVIDER_ERROR: '模型接口异常', STREAM_CUT: '响应中断，请重试',
  } : {
    MODEL_COMPLETED: 'Channel available (test returned text)', BOTH_IMAGES_AVAILABLE: 'AI Horde and Perchance accessible', HORDE_AVAILABLE: 'AI Horde accessible; Perchance unavailable', PERCHANCE_AVAILABLE: 'Perchance accessible; AI Horde unavailable', IMAGE_CHANNELS_UNAVAILABLE: 'Both image channels unavailable; check network and proxy', CATALOG_AVAILABLE: 'Free model catalog refreshed', IMAGE_MODELS_AVAILABLE: 'Endpoint accessible; image models online',
    IMAGE_ENDPOINTS_REACHABLE: 'Website and image endpoint accessible (generation untested)', RATE_LIMIT: 'Rate limited; retry later', TIMEOUT: 'Connection or response timed out; check proxy',
    TRANSPORT: 'Connection failed; check network and proxy', REGION_BLOCKED: 'Service restricted in this region', AUTH: 'Authentication refused', NO_ADAPTER: 'Free model plugin not ready',
    NO_FREE_MODELS: 'No free models advertised', NO_IMAGE_WORKERS: 'Endpoint accessible; no image workers online', EMPTY_RESPONSE: 'No completed text response',
    SERVER: 'Server error; retry later', CANCELLED: 'Check cancelled', NETWORK_OR_SERVICE_ERROR: 'Network or service unavailable; check proxy',
    PROVIDER_ERROR: 'Model endpoint error', STREAM_CUT: 'Response interrupted; retry',
  }
  return `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title>
<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:32px auto;padding:0 24px;max-width:1000px}h1{font-size:26px}p{color:light-dark(#586174,#b3bfd2);line-height:1.6}button{padding:8px 16px;border:1px solid #8885;border-radius:8px;cursor:pointer;background:light-dark(#f3f5fa,#283244);color:inherit}button:disabled{opacity:.5;cursor:default}#all{background:#526cf0;color:white}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #8883;font-size:13px}th{white-space:nowrap}td:first-child{max-width:250px;overflow-wrap:anywhere}.success{color:light-dark(#187a45,#6ce1a3)}.error{color:light-dark(#b72f36,#ff9297)}.running{color:light-dark(#405ccd,#aabaff)}small{display:block;opacity:.6;margin-top:5px}.detail{max-width:320px;overflow-wrap:anywhere}</style>
<h1>${copy.title}</h1><p>${copy.intro}</p><button id="all">${copy.all}</button> <button id="cancel" disabled>${copy.cancel}</button><p id="notice" role="status"></p>
<table><thead><tr><th>${copy.name}</th><th>${copy.status}</th><th>${copy.detail}</th><th>${copy.latency}</th><th>${copy.time}</th><th></th></tr></thead><tbody id="rows"></tbody></table><p>${copy.hint}</p>
<script nonce="${nonce}">
const copy=${JSON.stringify(copy)}, details=${JSON.stringify(details)}, base='/product/network', rows=document.querySelector('#rows'), notice=document.querySelector('#notice');
let busy=false, stopped=false;
async function request(action,target){const response=await fetch(base+'/state'+(action?'?action='+action+(target?'&target='+encodeURIComponent(target):''):''),{method:action?'POST':'GET',headers:action?{'X-Product-Diagnostics':'1'}:{}});if(!response.ok)throw new Error('HTTP '+response.status);return response.json()}
function render(state){busy=state.running;document.querySelector('#all').disabled=busy;document.querySelector('#cancel').disabled=!busy;notice.textContent='';rows.replaceChildren();for(const row of state.rows){const tr=document.createElement('tr');for(const value of [row.id==='models'?copy.models:copy.images,copy[row.status]||row.status,details[row.detail]||row.detail,row.elapsedMs==null?'—':(row.elapsedMs/1000).toFixed(1)+' s',row.checkedAt?new Date(row.checkedAt).toLocaleTimeString():'—']){const td=document.createElement('td');td.textContent=value;tr.append(td)}tr.children[1].className=row.status;tr.children[2].className='detail';const td=document.createElement('td'),button=document.createElement('button');button.textContent=copy.test;button.disabled=busy;button.onclick=()=>act('start',row.id);td.append(button);tr.append(td);rows.append(tr)}}
async function act(action,target){try{render(await request(action,target))}catch(error){notice.textContent=String(error)}}
document.querySelector('#all').onclick=()=>act('start');document.querySelector('#cancel').onclick=()=>act('cancel');
async function poll(){try{render(await request())}catch(error){notice.textContent=String(error)}if(!stopped)setTimeout(poll,1000)}
addEventListener('pagehide',()=>{stopped=true});poll();
</script></html>`
}
