/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { inspect } from 'node:util'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as generateImage from './generate-image.ts'
import * as hordeImages from './aihorde-images.ts'
import * as perchanceImages from './perchance-images.ts'
import * as desktopOffice from './office.ts'
import * as freeModels from './free-models.ts'
import * as freeAuto from './free-auto.ts'
import * as networkDiagnostics from './network-diagnostics.ts'
import * as desktopGodot from './godot.ts'
import * as gameValidation from './game-validation.ts'
import * as webgamePreview from './webgame-preview.ts'
import * as enginePresets from './engine-presets.ts'
import * as threejsStarter from './threejs-starter.ts'
import * as godotStarter from './godot-starter.ts'
import * as gameToolGroups from './game-tool-groups.ts'
import * as desktopEnvironments from './environments.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOfficeEngineResolution } from './office-engine.ts'

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  installOfficeEngineResolution(runtimeDir)
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  const environmentResources = process.env.AGENT_ENV_RESOURCES
  if (environmentResources === undefined) throw new Error('Desktop environment resources were not prepared')
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [join(environmentResources, 'desktop.patch.yml')],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
  } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  await ctx.plugin(freeModels, freeModels.parseConfig(JSON.parse(readFileSync(join(environmentResources, 'free-models.json'), 'utf8'))))
  await ctx.plugin(freeAuto, {
    recovery: freeModels.parseConfig(JSON.parse(readFileSync(join(environmentResources, 'free-models.json'), 'utf8'))),
    routeMs: 60_000, maxBufferBytes: 8 * 1024 * 1024,
    hiddenProviders: ['our-free-model', 'our-free-model-region'],
  })
  await ctx.plugin(networkDiagnostics, {
    free: freeModels.parseConfig(JSON.parse(readFileSync(join(environmentResources, 'free-models.json'), 'utf8'))),
    requestMs: 45_000, discoveryMs: 60_000,
  })
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  const godotResources = process.env.GODOT_RUNTIME_RESOURCES
  const godotRoot = process.env.GODOT_RUNTIME_ROOT
  if (godotResources === undefined || godotRoot === undefined) throw new Error('Desktop Godot launchers were not prepared')
  await ctx.plugin(desktopGodot, {
    worker: { idleMs: 60_000, requestMs: 30_000, maxBytes: 65_536 },
    root: godotRoot,
    resources: godotResources,
    primaryRuntime: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
  })
  await ctx.plugin(godotStarter, {
    resources: godotResources,
    primaryRuntime: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
  })
  await ctx.plugin(gameValidation, {
    root: godotRoot, resources: godotResources,
    primaryRuntime: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    buildMs: 600_000, operationMs: 30_000, idleMs: 30 * 60_000,
  })
  const launcherConfig = process.env.AGENT_ENV_CONFIG
  if (launcherConfig === undefined) throw new Error('Desktop environment launchers were not prepared')
  await ctx.plugin(desktopEnvironments, {
    timeoutMs: 35 * 60 * 1000,
    launcherConfig,
    resources: environmentResources,
    primaryRuntime: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
  })
  await ctx.plugin(hordeImages)
  await ctx.plugin(perchanceImages)
  await ctx.plugin(generateImage, {})
  await ctx.plugin(gameToolGroups, { defaultMode: 'all' })
  await ctx.plugin(threejsStarter, { primaryRuntime: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime') })
  await ctx.plugin(webgamePreview)
  await ctx.plugin(enginePresets)
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  const url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() }, (error) => { if (error !== null) console.error(error) })
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
