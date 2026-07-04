// Full-screen host for the workflow editor (owner feedback: the canvas needs the whole window,
// not a workspace panel). Rendered once at the App level next to SettingsModal, toggled via
// useUiStore.openWorkflowEditor/closeWorkflowEditor; the editor view inside is unchanged.
import React from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n'
import { useWcvSuppression } from '../useWcvSuppression'
import WorkflowEditorView from './WorkflowEditorView'
import { MemoryPane } from '../workspace/MemoryPane'

export function WorkflowEditorOverlay({
  profileId
}: {
  profileId: string
}): React.JSX.Element | null {
  const open = useUiStore((s) => s.workflowEditorOpen)
  const close = useUiStore((s) => s.closeWorkflowEditor)
  const t = useT()

  // WP6.4b: memory configuration home. A right-side sheet (the AgentPackDetail side-panel pattern)
  // hosts the self-contained MemoryPane (template binding, progress, backfill). The packs-shortcut
  // strip is hidden — there is no Installed rail to jump to from the editor.
  const [memoryOpen, setMemoryOpen] = React.useState(false)
  React.useEffect(() => {
    if (!open) setMemoryOpen(false)
  }, [open])

  // Native card views (WCVs — e.g. a 状态栏 regex panel) always paint ABOVE the DOM, so this
  // full-screen overlay can't cover them — duck them all for the editor's lifetime (refcounted,
  // shared with Modal so nested overlays don't restore early). Esc closes.
  useWcvSuppression(open)
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
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--rpt-bg-primary)',
        // Electron drag regions ignore z-order: the title bar's app-region:drag stays active
        // under this overlay, making the top ~48px strip (workflow picker, rename input, Save)
        // drag the window instead of clicking. no-drag punches the hole.
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          // Match the titleBarOverlay strip height (main/index.ts:43: 48px) so EVERYTHING below
          // the header — canvas, Memory sheet — starts clear of the native caption zone; without
          // this the sheet's own head (and its close button) rendered partly under the window
          // controls (owner report).
          minHeight: 48,
          boxSizing: 'border-box',
          // The native window controls (titleBarOverlay, main/index.ts:43) paint ABOVE the DOM in
          // the top-right corner; without this reservation the header's right-most buttons sit
          // under minimize/maximize/close (owner report). With Window Controls Overlay enabled,
          // env(titlebar-area-*) describes the DOM-usable strip — the controls occupy everything
          // right of area-x + area-width. Falls back to 0 where env() is unavailable.
          paddingRight:
            'calc(12px + (100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))',
          borderBottom: '1px solid var(--rpt-border)',
          flex: '0 0 auto'
        }}
      >
        <strong style={{ fontSize: 13 }}>{t('workflowEditor.viewTitle')}</strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setMemoryOpen((v) => !v)}
          title={t('workflowEditor.memoryTip')}
          style={{ fontSize: 12.5 }}
        >
          {t('workflowEditor.memory')}
        </button>
        <button
          type="button"
          onClick={close}
          title={`${t('workflowEditor.close')} (Esc)`}
          style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5 }}
        >
          <span aria-hidden style={{ fontSize: 13 }}>
            ✕
          </span>
          {t('workflowEditor.close')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <WorkflowEditorView profileId={profileId} />
        </div>
        {memoryOpen && (
          <div
            className="rpt-agentdetail rpt-memory-sheet"
            role="dialog"
            aria-label={t('workflowEditor.memory')}
          >
            <div className="rpt-agentdetail-head">
              <h2 className="rpt-agentdetail-title">{t('workflowEditor.memory')}</h2>
              <button
                type="button"
                className="rpt-agentdetail-close"
                onClick={() => setMemoryOpen(false)}
                title={t('workflowEditor.close')}
                aria-label={t('workflowEditor.close')}
              >
                ✕
              </button>
            </div>
            <div className="rpt-agentdetail-body">
              {/* MemoryPane is self-contained; the editor host has no Installed rail, so pass empty
                  pack inputs + hide the packs strip. */}
              <MemoryPane
                profileId={profileId}
                packs={null}
                gates={{}}
                onOpenPackDetail={() => {}}
                hidePacksStrip
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
