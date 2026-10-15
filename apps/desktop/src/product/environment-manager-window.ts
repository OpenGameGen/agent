/** On-demand, main-process-owned runtime management; never delays workspace startup. */
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { runCreationSetup } from './creation-setup-process.ts'
import type { CreationSetupOptions } from './creation-setup-window.ts'

let managerWindow: BrowserWindow | undefined
const targets = ['godot', 'blender', 'templates', 'node', 'python'] as const

/** Open a sandboxed management window using fixed resource commands. */
export async function showEnvironmentManager(options: CreationSetupOptions): Promise<void> {
  if (managerWindow && !managerWindow.isDestroyed()) { managerWindow.show(); managerWindow.focus(); return }
  const config = options.environment.AGENT_ENV_CONFIG
  const resources = options.environment.AGENT_ENV_RESOURCES
  if (!config || !resources) throw new Error('Environment management is not ready')
  const zh = options.chinese
  const names = { godot: 'Godot', blender: 'Blender', templates: zh ? 'Godot 导出模板' : 'Godot export templates', node: 'Node.js', python: 'Python' }
  const title = zh ? '创作环境管理' : 'Creation environments'
  const window = new BrowserWindow({ title, width: 780, height: 630, show: false,
    autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  managerWindow = window
  const controller = new AbortController()
  let busy = false
  window.on('closed', () => { controller.abort(); if (managerWindow === window) managerWindow = undefined })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const paint = async (text: string): Promise<void> => {
    if (!window.isDestroyed()) await window.webContents.executeJavaScript(`document.getElementById('report').textContent=${JSON.stringify(text)};document.body.dataset.busy=${JSON.stringify(String(busy))}`)
  }
  const execute = async (action: 'status' | 'ensure' | 'repair', target?: typeof targets[number]): Promise<void> => {
    if (busy || controller.signal.aborted) return
    busy = true
    try {
      await paint(zh ? '正在处理，请稍候。关闭窗口可取消。' : 'Working. Close this window to cancel.')
      let report = ''
      await runCreationSetup({ node: join(options.primaryRuntime, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
        cli: join(resources, 'cli.mjs'), config, environment: options.environment, signal: controller.signal, action,
        ...(target ? { target } : {}), onReport: (value) => { report = value },
        onProgress: (line) => { void paint(line).catch(() => {}) } })
      const status = JSON.parse(report) as Record<string, { version?: string; executable?: string; installed?: boolean; source?: string }>
      const rows = targets.map((kind) => {
        const entry = status[kind]
        return `${names[kind]}: ${entry?.version ?? '—'} · ${entry?.installed ? (zh ? '已安装' : 'Installed') : (zh ? '未安装' : 'Missing')} · ${entry?.source === 'system' ? (zh ? '复用本机安装' : 'System installation') : entry?.source === 'bundled' ? (zh ? '应用内置' : 'Bundled') : (zh ? '应用管理' : 'Managed')}\n${entry?.executable ?? ''}`
      })
      busy = false
      await paint(rows.join('\n\n'))
    } catch (error) {
      busy = false
      await paint(error instanceof Error ? error.message : String(error))
    } finally { busy = false }
  }
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    const match = /^opengamegen-environment:\/\/(status|ensure|repair)(?:\/(godot|blender|templates|node|python))?\/?$/u.exec(url)
    if (!match || (match[1] !== 'status' && !match[2])) return
    void execute(match[1] as 'status' | 'ensure' | 'repair', match[2] as typeof targets[number] | undefined)
  })
  const html = `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:14px system-ui;background:#f8fafc;color:#20252e;margin:28px}h1{font-size:24px}p{line-height:1.6}section{display:flex;gap:12px;flex-wrap:wrap}a{display:inline-block;color:#1664d8;padding:8px;border:1px solid #d5dce7;border-radius:6px;text-decoration:none}body[data-busy=true] a{pointer-events:none;opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:white;border-radius:8px;line-height:1.5}</style><h1>${title}</h1><p>${zh ? '按需准备工具，不影响应用启动。兼容版本的本机 Godot、Blender 会直接复用；其他版本会保留。导出模板仅在运行或导出需要时安装。Node.js、Python 随应用内置；损坏时请重装应用。' : 'Prepare tools on demand. Compatible system Godot and Blender are reused; other installations are preserved. Export templates are installed separately.'}</p><section><a href="opengamegen-environment://status">${zh ? '重新检测' : 'Refresh'}</a>${targets.map(target => `<a href="opengamegen-environment://ensure/${target}">${zh ? '准备' : 'Prepare'} ${names[target]}</a>`).join('')}</section><p>${zh ? '已管理的工具损坏时：' : 'Repair managed tools:'} ${(['godot', 'blender', 'templates'] as const).map(target => `<a href="opengamegen-environment://repair/${target}">${names[target]}</a>`).join(' ')}</p><pre id="report"></pre></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  window.show()
  await execute('status')
}
