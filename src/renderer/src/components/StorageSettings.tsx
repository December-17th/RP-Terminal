import { useEffect, useState } from 'react'
import { useT } from '../i18n'

export function StorageSettings(): React.ReactElement {
  const t = useT()
  const [current, setCurrent] = useState<string>('')
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getDataLocation().then((loc) => setCurrent(loc?.path ?? ''))
  }, [])

  const change = async (): Promise<void> => {
    const picked = await window.api.setDataLocationDialog()
    if (picked) setPending(picked)
  }
  const reset = async (): Promise<void> => {
    await window.api.resetDataLocation()
    setPending(t('settings.storage.reset'))
  }

  return (
    <details className="settings-section" style={{ marginTop: 20 }}>
      <summary>{t('settings.storage.title')}</summary>
      <div className="settings-section-body">
        <label className="field-label">{t('settings.storage.current')}</label>
        <div style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--rpt-text-secondary)' }}>
          {current}
        </div>
        <div className="preset-actions" style={{ marginTop: 8 }}>
          <button onClick={change}>{t('settings.storage.change')}</button>
          <button onClick={() => void window.api.openDataLocation()}>
            {t('settings.storage.open')}
          </button>
          <button onClick={reset}>{t('settings.storage.reset')}</button>
        </div>
        {pending && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: '0.8em', color: 'var(--rpt-text-secondary)' }}>
              {t('settings.storage.pending', { path: pending })}
            </div>
            <div style={{ fontSize: '0.8em', marginTop: 2 }}>{t('settings.storage.restartHint')}</div>
            <button style={{ marginTop: 6 }} onClick={() => void window.api.restartApp()}>
              {t('settings.storage.restartNow')}
            </button>
          </div>
        )}
      </div>
    </details>
  )
}
