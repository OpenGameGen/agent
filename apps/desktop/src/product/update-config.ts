/** Read only sealed application metadata; ambient environment cannot opt users into another feed. */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
export function productUpdateConfig(appPath: string): { channel: string; github: true } | undefined {
  if (!existsSync(join(appPath, 'package.json'))) return undefined
  const value: unknown = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8'))
  if (typeof value !== 'object' || value === null || !('dshProductAutoUpdate' in value)) return undefined
  const config = value.dshProductAutoUpdate
  if (typeof config !== 'object' || config === null || !('github' in config) || config.github !== true || !('channel' in config)
    || typeof config.channel !== 'string' || !/^nightly-(?:arm64|x64)$/u.test(config.channel)) throw new Error('Invalid sealed product update configuration')
  return { channel: config.channel, github: true }
}
