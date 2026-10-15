import { defineConfig } from 'tsdown'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export default defineConfig(['index', 'cli', 'engine-agent'].map(name => ({
  entry: ['lib/types/' + name + '.js'],
  outDir: 'lib',
  format: ['esm'] as const,
  outputOptions: { codeSplitting: false },
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Node-mode Electron must parse the shipped entry before the build is accepted.
  onSuccess: () => {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`./lib/${name}.js`, import.meta.url))])
  },
})))
