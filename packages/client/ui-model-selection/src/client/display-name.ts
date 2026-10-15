/** Localized labels only; routing and persisted model IDs stay unchanged. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Resolve the visible provider label.
 * @param id - Provider routing identifier.
 * @param name - Original provider label.
 * @param t - Model locale translator.
 * @returns Localized product label or the original provider label.
 */
export function providerDisplayName(id: string, name: string, t: TranslateNS<'model'>): string {
  return id === 'free-auto' ? t('provider.freeAuto') : id === 'deepseek-account' ? t('provider.account') : name
}

/** Resolve the visible model label without renaming other providers' models.
 * @param provider - Provider routing identifier.
 * @param id - Model routing identifier.
 * @param name - Original model label.
 * @param t - Model locale translator.
 * @returns Localized product label or the original model label.
 */
export function modelDisplayName(provider: string, id: string, name: string, t: TranslateNS<'model'>): string {
  return provider === 'free-auto' && id === 'free-auto' ? t('provider.freeAuto') : name
}
