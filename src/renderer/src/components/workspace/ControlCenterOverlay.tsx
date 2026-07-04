// Full-window host for the Agents & Workflows control center (owner directive WP3.7: too much is
// going on in the Agents + Workflow panels — they no longer belong in a workspace panel). Rendered
// once at the App level next to WorkflowEditorOverlay, toggled via useUiStore.openControlCenter /
// closeControlCenter. It hosts AgentsView (which now carries the Workflows management pane too) at
// full width. The workflow EDITOR remains its own overlay (the canvas needs the whole window); both
// overlays coexist — opening the editor from here leaves the control center mounted underneath and
// the editor paints above it (higher z-index), so closing the editor returns to the control center.
//
// Mirrors WorkflowEditorOverlay exactly: fixed full-viewport, WCV suppression (native card views
// paint above the DOM), Escape to close, no-drag to punch through the title bar's drag region.
import React from 'react'
import { useT } from '../../i18n'
import { useWcvSuppression } from '../useWcvSuppression'
import { AgentsView } from './AgentsView'
import { resolveInitialRail } from './controlCenterRail'

export function ControlCenterOverlay({ profileId }: { profileId: string }): React.JSX.Element | null {
  // WP6.4b: the control center is retired — this file is unreferenced (App.tsx no longer mounts it)
  // and is deleted wholesale in WP6.6. Its uiStore fields are gone, so the open/rail/close wiring is
  // reduced to inert stand-ins that keep it compiling until then (it never opens: `open` is const false).
  const open = false
  const requestedRail = null
  const consumeRail = (): void => {}
  const close = (): void => {}
  const t = useT()

  // Native card views (WCVs) always paint ABOVE the DOM, so this full-screen overlay can't cover
  // them — duck them for its lifetime (refcounted; shared with the editor overlay so a Studio
  // hand-off from here doesn't restore them early).
  useWcvSuppression(open)

  // Snapshot the requested rail once when the overlay opens (a deep-link hand-off), then clear it so
  // the store request can't re-apply on a later re-render. AgentsView owns its rail after mount.
  const [initialRail, setInitialRail] = React.useState(() => resolveInitialRail(requestedRail))
  const wasOpen = React.useRef(false)
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setInitialRail(resolveInitialRail(requestedRail))
      consumeRail()
    }
    wasOpen.current = open
  }, [open, requestedRail, consumeRail])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  return (
    <div
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 90,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--rpt-bg-primary)',
          // The title bar's app-region:drag ignores z-order — without this the top strip would drag
          // the window instead of clicking the header controls (same fix as the editor overlay).
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties
      }
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderBottom: '1px solid var(--rpt-border)',
          flex: '0 0 auto'
        }}
      >
        <strong style={{ fontSize: 13 }}>{t('controlCenter.title')}</strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={close}
          title={`${t('controlCenter.close')} (Esc)`}
          style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5 }}
        >
          <span aria-hidden style={{ fontSize: 13 }}>
            ✕
          </span>
          {t('controlCenter.close')}
        </button>
      </div>
      {/* key forces a fresh AgentsView (and thus a fresh initial rail) on each open. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <AgentsView key={initialRail} profileId={profileId} initialRail={initialRail} />
      </div>
    </div>
  )
}
