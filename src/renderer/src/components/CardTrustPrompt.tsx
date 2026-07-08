// Import-time card-script TRUST consent modal. When a freshly imported world ships scripts
// (native rp_terminal.scripts + bundled TH scripts), characterStore opens this prompt. It asks
// once, records the decision into the persisted per-card grants (`trusted`/`remoteScripts` +
// `decided`), and seeds the reactive trust store — so the invisible run-time script hosts
// (CardScriptWcvHost / CardScriptHost) never re-prompt.
//
// Why a modal and not the old bottom-left run-time prompt: native card WebContentsView panels
// paint ABOVE the DOM and visually occluded that prompt. This uses the shared frosted-glass
// `.modal-overlay` popup (mirrors AssetsPopup); popups also duck the WCVs, so it can't be hidden.
// At import time there is no open session yet, so no WCV is even mounted.
import React from 'react'
import { useUiStore } from '../stores/uiStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { useT } from '../i18n'
import { useWcvSuppression } from './useWcvSuppression'

export function CardTrustPrompt(): React.JSX.Element | null {
  const tp = useUiStore((s) => s.trustPrompt)
  const t = useT()

  // Consistency + safety: duck any native card WCVs while the prompt is up (mirrors the popups).
  useWcvSuppression(!!tp)

  // Both Esc and a backdrop click take the DENY path — showing the prompt always records a
  // decision, so we never leave the card in an undecided (re-prompting) state once seen.
  const decide = React.useCallback(async (trust: boolean): Promise<void> => {
    const cur = useUiStore.getState().trustPrompt
    if (!cur) return
    await window.api.pluginSetGrants(cur.profileId, cur.cardId, {
      trusted: trust,
      remoteScripts: trust,
      decided: true
    })
    useCardScriptsStore.getState().seedTrust(cur.cardId, trust)
    useUiStore.getState().closeTrustPrompt()
  }, [])

  React.useEffect(() => {
    if (!tp) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void decide(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tp, decide])

  if (!tp) return null

  return (
    <div className="modal-overlay" onClick={() => void decide(false)}>
      <div
        className="rpt-popup-modal rpt-popup-modal-trust"
        role="dialog"
        aria-modal="true"
        aria-label={t('trust.title', { name: tp.cardName })}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rpt-popup-modal-head">
          <strong>{t('trust.title', { name: tp.cardName })}</strong>
        </div>
        <div className="rpt-popup-modal-body">
          <p className="rpt-trust-body">{t('trust.body')}</p>
          <p className="rpt-trust-warning">{t('trust.warning')}</p>
          <div className="rpt-trust-actions">
            <button className="btn-ghost" onClick={() => void decide(false)}>
              {t('trust.deny')}
            </button>
            <button className="btn-accent" onClick={() => void decide(true)}>
              {t('trust.trust')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
