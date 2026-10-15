import { expect, it, vi } from 'vitest'
import { execute } from '../resources/godot/runtime.mjs'

const path = '/fixture/project.godot'
const fatal = `ERROR: Error parsing '${path}' at line 10: Expected property name as string File might be corrupted.\n   at: _load_settings_text (core/config/project_settings.cpp:972)\nERROR: Couldn't load file '${path}', error code 43.\n   at: _load_settings_text_or_binary (core/config/project_settings.cpp:1021)\n`

it('recognizes split native startup configuration failure and returns failure promptly', async () => {
  const script = `const s=${JSON.stringify(fatal)}; let i=0; setInterval(()=>{if(i<s.length)process.stderr.write(s.slice(i,i+=7))},1)`
  const result = await execute(process.execPath, ['-e', script], { quiet: true, startupProjectConfig: path, timeoutMs: 3000, operation: 'Fixture import' })
  expect(result.code).toBe(1)
  expect(result.output).toContain('error code 43')
})

it('does not stop warnings, script errors, another path or post-startup project output', async () => {
  for (const [stdout, stderr] of [
    ['', 'WARNING: harmless\nSCRIPT ERROR: Parse Error: ordinary script\n'],
    ['', fatal.replaceAll(path, '/other/project.godot')],
    ['Godot Engine v4.6\n', fatal],
  ]) {
    const script = `process.stdout.write(${JSON.stringify(stdout)});setTimeout(()=>{process.stderr.write(${JSON.stringify(stderr)});setTimeout(()=>process.exit(7),30)},30)`
    const result = await execute(process.execPath, ['-e', script], { quiet: true, startupProjectConfig: path, timeoutMs: 3000 })
    expect(result.code).toBe(7)
  }
})

it('keeps timeout exit 124 with an explicit operation and duration diagnostic', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const result = await execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { quiet: true, timeoutMs: 50, operation: 'Fixture import' })
    expect(result.code).toBe(124)
    expect(error).toHaveBeenCalledWith('Fixture import timed out after 50 ms; stopping the engine.')
  } finally { error.mockRestore() }
})

it('matches exact Windows-style paths with spaces without treating alternate spellings as equal', async () => {
  const windowsPath = 'C:\\Game Projects\\Demo\\project.godot'
  for (const [printed, expected] of [[windowsPath, 1], [windowsPath.replaceAll('\\', '/'), 7]] as const) {
    const diagnostic = fatal.replaceAll(path, printed).replaceAll('\n', '\r\n')
    const script = `process.stderr.write(${JSON.stringify(diagnostic)});setTimeout(()=>process.exit(7),100)`
    const result = await execute(process.execPath, ['-e', script], { quiet: true, startupProjectConfig: windowsPath, timeoutMs: 3000 })
    expect(result.code).toBe(expected)
  }
})
