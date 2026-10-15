import { expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { modelDisplayName, providerDisplayName } from '../src/client/display-name.ts'
import { zh, en } from '../src/client/locales.ts'

it('localizes automatic free model labels while preserving English and unrelated names', () => {
  const chinese: TranslateNS<'model'> = key => (zh as Record<string, string>)[key] ?? key
  const english: TranslateNS<'model'> = key => (en as Record<string, string>)[key] ?? key
  expect(providerDisplayName('free-auto', 'free-auto', chinese)).toBe('免费模型-自动')
  expect(modelDisplayName('free-auto', 'free-auto', 'free-auto', chinese)).toBe('免费模型-自动')
  expect(modelDisplayName('free-auto', 'free-auto', 'free-auto', english)).toBe('free-auto')
  expect(modelDisplayName('glm-coding', 'glm-5.3-flash', 'GLM-5.3-flash', chinese)).toBe('GLM-5.3-flash')
  expect(modelDisplayName('other-provider', 'free-auto', 'Original name', chinese)).toBe('Original name')
})
