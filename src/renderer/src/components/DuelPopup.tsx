// Centered modal host for the interactive STS duel (DuelView). The duel board is built from
// pixel-absolute rows over a fixed stage, so hosting it in a resizable workspace panel scrambled
// the elements at small sizes (owner report). A fixed-size popup gives it a stable canvas.
//
// Lifecycle: auto-opens when a duel becomes active (chat mode transitions to 'duel'), auto-closes
// when the mode leaves 'duel'. Closing manually (✕ / Esc / backdrop) only hides the popup — the duel
// stays live and can be reopened (ChatView's "reopen" button, or the duel-view launcher).
import React from 'react'
import { useChatStore } from '../stores/chatStore'
import { useUiStore } from '../stores/uiStore'
import { useT } from '../i18n'
import { useWcvSuppression } from './useWcvSuppression'
import { DuelView } from './workspace/DuelView'

export function DuelPopup({ profileId }: { profileId: string }): React.JSX.Element | null {
  const mode = useChatStore((s) => s.activeChatMode)
  const open = useUiStore((s) => s.duelPopupOpen)
  const openDuel = useUiStore((s) => s.openDuelPopup)
  const closeDuel = useUiStore((s) => s.closeDuelPopup)
  const t = useT()

  // Follow the chat mode: entering 'duel' opens the popup, leaving it closes it. Keyed on `mode`
  // alone, so a manual close (which doesn't change the mode) is NOT reverted — the effect only
  // re-fires on an actual mode transition.
  React.useEffect(() => {
    if (mode === 'duel') openDuel()
    else closeDuel()
  }, [mode, openDuel, closeDuel])

  // Native card WCVs paint above the DOM (ignore z-order); duck them while the popup is up.
  useWcvSuppression(open)
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDuel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeDuel])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={closeDuel}>
      <div className="rpt-duel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rpt-duel-modal-head">
          <strong>{t('duel.popupTitle')}</strong>
          <button className="btn-ghost" title={`${t('duel.close')} (Esc)`} onClick={closeDuel}>
            ✕
          </button>
        </div>
        <div className="rpt-duel-modal-body">
          <DuelView profileId={profileId} />
        </div>
      </div>
    </div>
  )
}
