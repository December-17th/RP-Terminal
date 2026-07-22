import { useEffect, useState } from 'react'
import { WcvPanel } from '../workspace/WcvPanel'
import { useT } from '../../i18n'

/**
 * MVP Yuzu takeover surface. The card owns the play-area rectangle through the existing, unrestricted
 * card WCV preload. Its explicit generation flag is applied before the page mounts.
 *
 * A rejected `setVnMode` IPC lands in the localized error state instead of mounting a blank WCV.
 */
export function YuzuCardSurface({
  profileId,
  chatId,
  entry,
  enableVnMode
}: {
  profileId: string
  chatId: string
  entry: string
  enableVnMode: boolean
}): React.ReactElement {
  const t = useT()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    void window.api
      .setVnMode(profileId, chatId, enableVnMode)
      .then(() => {
        if (!cancelled) setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [profileId, chatId, enableVnMode])

  return (
    <div className="yuzu-surface">
      <div className="yuzu-surface__body">
        {status === 'error' ? (
          <div className="yuzu-surface__fallback" role="alert">
            {t('yuzu.surface.loadError')}
          </div>
        ) : status === 'ready' ? (
          <WcvPanel slotId={`yuzu:${chatId}`} url={entry} />
        ) : null}
      </div>
    </div>
  )
}
