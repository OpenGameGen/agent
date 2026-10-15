/** Environment management entry in General Settings. */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
export function EnvironmentRow({ t }: PropsRuntime<'settings.general.item'> & PropsLocale<'productEnvironments'>) {
  const [failed, setFailed] = useState(false)
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }}>
    <div><div style={{ fontSize: 14 }}>{t('title')}</div>
      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('description')}</div>
      {failed && <div role="alert">{t('failed')}</div>}
    </div>
    <button type="button" style={{ border: 0, borderRadius: 10, padding: '10px 16px', cursor: 'pointer' }} onClick={() => {
      const carrier = (globalThis as typeof globalThis & { dshDesktop?: { environments?: { open(): Promise<void> } } }).dshDesktop
      setFailed(false)
      if (!carrier?.environments) { setFailed(true); return }
      void carrier.environments.open().catch(() => { setFailed(true) })
    }}>{t('open')}</button>
  </div>
}
