// Full-window centered popup host for the World Assets manager (AssetsView). Mirrors DuelPopup.
//
// Why a popup and not a docked workspace panel: when a card owns the play area (rp_terminal.panel_ui
// mode:'static'), App renders StaticWorkspace instead of the reconfigurable Workspace — so the old
// Settings "Open Assets view" button, which docked an 'assets' panel into the Workspace layout,
// surfaced nothing. This popup layers above BOTH StaticWorkspace and Workspace, so the button reaches
// Assets in either case.
//
// Lifecycle: opened only by the Settings button (openAssetsPopup); closed by ✕ / Esc / backdrop.
// Renders nothing unless open AND a world is active (the button is already gated on activeCharacter).
import React from 'react'
import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { useUiStore } from '../stores/uiStore'
import { useT } from '../i18n'
import { useWcvSuppression } from './useWcvSuppression'
import { broadcastHostEvent } from '../cardBridge/hostBroadcast'
import { AssetsView } from './workspace/AssetsView'

export function AssetsPopup({ profileId }: { profileId: string }): React.JSX.Element | null {
  const open = useUiStore((s) => s.assetsPopupOpen)
  const close = useUiStore((s) => s.closeAssetsPopup)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const chatId = useChatStore((s) => s.activeChatId)
  const t = useT()

  // Closing the Assets viewer broadcasts `assets:changed` to the card's WCV surfaces so newly-added art
  // (立绘 / 背景 / 头像) shows at once — the surfaces re-resolve their asset URLs on this event instead of
  // waiting for a reload. Harmless when nothing changed (the surfaces just re-resolve, cheap).
  const handleClose = React.useCallback((): void => {
    if (chatId) broadcastHostEvent(chatId, 'assets:changed')
    close()
  }, [chatId, close])

  // Native card WCVs paint above the DOM (ignore z-order); duck them while the popup is up.
  useWcvSuppression(open)
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, handleClose])

  if (!open || !activeCharacter) return null

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="rpt-popup-modal rpt-popup-modal-assets"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.assetsTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rpt-popup-modal-head">
          <strong>{t('settings.assetsTitle')}</strong>
          <button className="btn-ghost" title={`${t('common.close')} (Esc)`} onClick={handleClose}>
            ✕
          </button>
        </div>
        <div className="rpt-popup-modal-body">
          <AssetsView profileId={profileId} />
        </div>
      </div>
    </div>
  )
}
