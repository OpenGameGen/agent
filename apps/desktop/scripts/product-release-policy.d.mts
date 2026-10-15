import type { DesktopAutoUpdateConfig, DesktopUploadConfig } from './desktop-auto-update-environment.mjs'
import type { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
export function productUpdatesEnabled(env: NodeJS.ProcessEnv): boolean
export function resolveProductUpdateConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, arch: string): DesktopAutoUpdateConfig | undefined
export function resolveProductUploadConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, arch: string): DesktopUploadConfig
export function resolveProductMandatoryPolicy(env: NodeJS.ProcessEnv): ReturnType<typeof resolveDesktopPolicyEnvironment> | undefined
export function assertProductUpdatesAbsent(resources: string): Promise<void>
export function verifyProductMacOSUpdateConfig(appPath: string, update: { publicUrl: string } | undefined): Promise<void>
export function assertProductQualificationDestination(env: NodeJS.ProcessEnv, run: { origin: string; bucket: string; feedKey: string }): void
