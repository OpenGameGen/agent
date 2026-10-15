import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startWebGameServer } from '../src/webgame-preview.ts'

it('serves compiled game assets and early error observation without exposing outside or hidden files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webgame-test-'))
  let server: Awaited<ReturnType<typeof startWebGameServer>>['server'] | undefined
  try {
    const game = join(root, 'game'); await mkdir(game)
    await writeFile(join(game, 'index.html'), '<!doctype html><html><head><title>Game</title></head><body>Ready</body></html>')
    await writeFile(join(game, 'main.js'), 'window.__game={score:0}')
    await writeFile(join(game, '.private.json'), '{"secret":"test-only"}')
    await writeFile(join(root, 'outside.json'), '{}')
    await symlink(join(root, 'outside.json'), join(game, 'leak.json'))
    const started = await startWebGameServer(game, 'test'); server = started.server
    const html = await (await fetch(started.url)).text()
    expect(html).toContain('<head><script src="/__webgame_observer.js"></script>')
    const origin = new URL(started.url).origin
    expect((await fetch(origin + '/main.js')).status).toBe(200)
    expect((await fetch(origin + '/leak.json')).status).toBe(404)
    expect((await fetch(origin + '/.private.json')).status).toBe(404)
    expect((await fetch(origin + '/%2e%2e/outside.json')).status).toBe(404)
    expect((await fetch(origin + '/__webgame_observer.js')).headers.get('content-type')).toBe('text/javascript')
  } finally {
    server?.closeAllConnections()
    if (server) await new Promise<void>(resolve => server?.close(() =>{  resolve() }))
    await rm(root, { recursive: true, force: true })
  }
})
