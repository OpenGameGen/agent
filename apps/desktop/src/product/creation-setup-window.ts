/** Automatic creation-environment preparation owned by the desktop shell. */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { runCreationSetup } from './creation-setup-process.ts'

const messages = {
  zh: { title: '修复创作环境', description: '检测到创作环境缺失或损坏，正在修复。完成后将自动进入应用，已就绪的组件会被复用。', checking: '正在检查已安装环境', running: '正在修复创作环境', failed: '准备未完成，请检查网络和磁盘空间后重试。', retry: '重试', details: '修复详情', node: '基础运行环境', python: '脚本运行环境', godot: '游戏引擎', blender: '3D 创作工具', templates: '游戏运行与导出支持', ready: '已就绪', reused: '已就绪（复用已有安装）', installing: '正在安装', reusing: '正在复用已有安装' },
  en: { title: 'Repairing your creation environment', description: 'Missing or damaged components were detected. Repair will reuse healthy components and open the app when ready.', checking: 'Checking installed components', running: 'Repairing creation environment', failed: 'Setup could not finish. Check your connection and disk space, then retry.', retry: 'Retry', details: 'Repair details', node: 'Base runtime', python: 'Script runtime', godot: 'Game engine', blender: '3D creation tools', templates: 'Game preview and export support', ready: 'Ready', reused: 'Ready (existing installation)', installing: 'Installing', reusing: 'Reusing existing installation' },
} as const

/** Trusted locations already validated by the desktop environment modules. */
export interface CreationSetupOptions {
  readonly primaryRuntime: string
  readonly environment: NodeJS.ProcessEnv
  readonly chinese: boolean
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/**
 * Keep the workspace unavailable until every dependency is verified; retry preserves completed work.
 * @param options - Installer locations and desktop-selected language.
 * @returns Resolves when the environment is ready, or rejects after cancelled work exits.
 */
export async function prepareCreationSetup(options: CreationSetupOptions): Promise<void> {
  const copy = options.chinese ? messages.zh : messages.en
  const config = options.environment.AGENT_ENV_CONFIG
  const resources = options.environment.AGENT_ENV_RESOURCES
  if (!config || !resources) throw new Error('Desktop environment launchers must be prepared before creation setup')
  const controller = new AbortController()
  const checkingCancelled = (): void => { controller.abort(new DOMException('Creation setup cancelled', 'AbortError')) }
  app.on('before-quit', checkingCancelled)
  try {
    await runCreationSetup({ checkOnly: true, node: join(options.primaryRuntime, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      cli: join(resources, 'cli.mjs'), config, environment: options.environment, signal: controller.signal, onProgress: () => {} })
    return
  } catch {
    controller.signal.throwIfAborted()
  } finally { app.removeListener('before-quit', checkingCancelled) }

  const window = new BrowserWindow({ width: 580, height: 490, title: copy.title, show: false, resizable: false,
    autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  const html = `<!doctype html><html lang="${options.chinese ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:15px system-ui;color:#20252e;background:#f8fafc;margin:32px}h1{font-size:23px}p{line-height:1.6;color:#556070}li{padding:7px 0}progress{width:100%;height:8px}pre{white-space:pre-wrap;word-break:break-word;font:12px monospace;max-height:110px;overflow:auto}a{display:inline-block;background:#2563eb;color:white;padding:9px 24px;border-radius:8px;text-decoration:none}details{margin-top:16px}[hidden]{display:none!important}</style><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.description)}</p><progress id="progress"></progress><p id="status">${escapeHtml(copy.checking)}</p><ul>${(['node','python','godot','blender','templates'] as const).map(target => `<li>${escapeHtml(copy[target])} <span id="${target}"></span></li>`).join('')}</ul><a id="retry" href="https://setup.invalid/retry" hidden>${escapeHtml(copy.retry)}</a><details><summary>${escapeHtml(copy.details)}</summary><pre id="details"></pre></details></html>`
  // No page IPC or remote content: the only navigation is a main-owned retry action.
  let retry: (() => void) | undefined
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url === 'https://setup.invalid/retry') retry?.()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const cancel = (): void =>{  controller.abort(new DOMException('Creation setup cancelled', 'AbortError')) }
  window.on('closed', () => { cancel(); app.quit() })
  app.on('before-quit', cancel)
  const update = async (state: { status?: string; target?: string; label?: string; detail?: string; failed?: boolean }): Promise<void> => {
    if (window.isDestroyed()) return
    await window.webContents.executeJavaScript(`(() => { const state = ${JSON.stringify(state)}; if (state.status) document.getElementById('status').textContent = state.status; if (state.target) document.getElementById(state.target).textContent = state.label; if (state.detail !== undefined) document.getElementById('details').textContent = state.detail; if (state.failed !== undefined) { document.getElementById('retry').hidden = !state.failed; document.getElementById('progress').hidden = state.failed; } })()`)
  }
  let paint = Promise.resolve()
  let detail = ''
  const progress = (line: string): void => {
    detail = (detail + line + '\n').slice(-4096)
    const state: Parameters<typeof update>[0] = { detail, status: copy.running }
    if (line.startsWith('Setup-stage: ')) {
      const stage: unknown = JSON.parse(line.slice('Setup-stage: '.length))
      if (typeof stage === 'object' && stage !== null && 'target' in stage && typeof stage.target === 'string'
        && ['node','python','godot','blender','templates'].includes(stage.target) && 'phase' in stage) {
        state.target = stage.target
        state.label = stage.phase === 'ready' ? ('reused' in stage && stage.reused ? copy.reused : copy.ready)
          : stage.phase === 'installing' ? copy.installing : stage.phase === 'reusing' ? copy.reusing : copy.checking
      }
    }
    paint = paint.then(() => update(state)).catch((error: unknown) => {
      // A destroyed window cancels setup; other renderer failures stop the installer.
      controller.abort(error)
    })
  }
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const show = setTimeout(() => { if (!window.isDestroyed()) window.show() }, 700)
    try {
      for (;;) {
        controller.signal.throwIfAborted()
        await update({ status: copy.checking, failed: false })
        try {
          await runCreationSetup({ node: join(options.primaryRuntime, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
            cli: join(resources, 'cli.mjs'), config, environment: options.environment, signal: controller.signal, onProgress: progress })
          await paint
          controller.signal.throwIfAborted()
          return
        } catch (error) {
          controller.signal.throwIfAborted()
          await paint
          window.show()
          await update({ status: copy.failed, detail: error instanceof Error ? error.message : String(error), failed: true })
          await new Promise<void>((resolve, reject) => {
            const aborted = (): void => { retry = undefined; reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Creation setup cancelled')) }
            retry = () => { retry = undefined; controller.signal.removeEventListener('abort', aborted); resolve() }
            controller.signal.addEventListener('abort', aborted, { once: true })
            if (controller.signal.aborted) aborted()
          })
        }
      }
    } finally { clearTimeout(show) }
  } finally {
    app.removeListener('before-quit', cancel)
    window.removeAllListeners('closed')
    if (!window.isDestroyed()) window.destroy()
  }
}
