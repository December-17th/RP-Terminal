import { useEffect, useState } from 'react'
import { WcvPanel } from '../workspace/WcvPanel'
import { useCardScriptsStore } from '../../stores/cardScriptsStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n'

/**
 * MVP Yuzu takeover surface. The card owns the play-area rectangle through the existing, unrestricted
 * card WCV preload. Its explicit generation flag is applied before the page mounts.
 *
 * Two localized in-app fallbacks keep the surface from painting a blank or raw native error:
 * - A rejected `setVnMode` IPC lands in the `loadError` state instead of mounting a blank WCV.
 * - When the card's script grants are undecided or trust was denied, the main-side card-code serve gate
 *   (`decided ∧ trusted`) would refuse the WCV, so we show the `untrusted` fallback with a Settings →
 *   Scripts shortcut instead. The trust state is a reactive subscription to `useCardScriptsStore`:
 *   granting trust in that panel auto-mounts the WCV here with no re-entry.
 */
export function YuzuCardSurface({
  profileId,
  chatId,
  cardId,
  entry,
  enableVnMode
}: {
  profileId: string
  chatId: string
  cardId: string
  entry: string
  enableVnMode: boolean
}): React.ReactElement {
  const t = useT()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const trusted = useCardScriptsStore((s) => s.trustedByCard[cardId] ?? false)
  const resolved = useCardScriptsStore((s) => cardId in s.decidedByCard)
  const decided = useCardScriptsStore((s) => s.decidedByCard[cardId] === true)

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

  // Resolve the card's script grants so the trust gate below reflects the persisted decision.
  useEffect(() => {
    if (!resolved) void useCardScriptsStore.getState().load(profileId, cardId)
  }, [profileId, cardId, resolved])

  return (
    <div className="yuzu-surface">
      <div className="yuzu-surface__body">
        {status === 'error' ? (
          <div className="yuzu-surface__fallback" role="alert">
            {t('yuzu.surface.loadError')}
          </div>
        ) : !resolved ? (
          // Grants not yet resolved — avoid flashing the untrusted state before the decision loads.
          null
        ) : !(decided && trusted) ? (
          <div className="yuzu-surface__fallback" role="alert">
            <span>{t('yuzu.surface.untrusted')}</span>
            <button
              type="button"
              className="yuzu-surface__settings"
              onClick={() => useUiStore.getState().openSettings('scripts')}
            >
              {t('yuzu.surface.openScripts')}
            </button>
          </div>
        ) : status === 'ready' ? (
          <WcvPanel slotId={`yuzu:${chatId}`} url={entry} />
        ) : null}
      </div>
    </div>
  )
}
