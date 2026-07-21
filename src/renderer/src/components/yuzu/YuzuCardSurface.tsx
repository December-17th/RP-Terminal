import { useEffect, useState } from 'react'
import { WcvPanel } from '../workspace/WcvPanel'
import { useT } from '../../i18n'

/**
 * MVP Yuzu takeover surface. The card owns the play-area rectangle through the existing, unrestricted
 * card WCV preload. Its explicit generation flag is applied before the page mounts.
 *
 * Failure story (renderer/Yuzu review): the takeover REPLACES the whole workspace (App.tsx), so if it
 * rendered nothing on failure the user would be stranded with no chat UI. Two escapes:
 *   - A rejected `setVnMode` IPC lands in the `error` state — a localized message instead of a blank
 *     surface, with the exit control still present.
 *   - A persistent, unobtrusive exit control in a slim top bar. The card-code WCV is a native
 *     WebContentsView painted OVER the renderer DOM, so an in-rect overlay would be occluded; a
 *     declined trust grant / failed code-serve therefore shows a raw native error page. Reserving the
 *     bar ABOVE the WCV rect keeps the escape reachable even then. `onExit` returns to the classic
 *     workspace (App.tsx suppresses the surface for this chat).
 */
export function YuzuCardSurface({
  profileId,
  chatId,
  entry,
  enableVnMode,
  onExit
}: {
  profileId: string
  chatId: string
  entry: string
  enableVnMode: boolean
  onExit: () => void
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
      <div className="yuzu-surface__bar">
        <button
          type="button"
          className="yuzu-surface__exit"
          onClick={onExit}
          title={t('yuzu.surface.exitTitle')}
        >
          {t('yuzu.surface.exit')}
        </button>
      </div>
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
