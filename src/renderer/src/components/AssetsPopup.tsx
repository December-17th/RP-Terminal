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
import { useUiStore } from '../stores/uiStore'
import { useT } from '../i18n'
import { useWcvSuppression } from './useWcvSuppression'
import { AssetsView } from './workspace/AssetsView'

export function AssetsPopup({ profileId }: { profileId: string }): React.JSX.Element | null {
  const open = useUiStore((s) => s.assetsPopupOpen)
  const close = useUiStore((s) => s.closeAssetsPopup)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const t = useT()

  // Native card WCVs paint above the DOM (ignore z-order); duck them while the popup is up.
  useWcvSuppression(open)
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open || !activeCharacter) return null

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="rpt-popup-modal rpt-popup-modal-assets"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.assetsTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rpt-popup-modal-head">
          <strong>{t('settings.assetsTitle')}</strong>
          <button className="btn-ghost" title={`${t('common.close')} (Esc)`} onClick={close}>
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
