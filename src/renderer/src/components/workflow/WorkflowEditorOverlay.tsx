// Full-screen host for the workflow editor (owner feedback: the canvas needs the whole window,
// not a workspace panel). Rendered once at the App level next to SettingsModal, toggled via
// useUiStore.openWorkflowEditor/closeWorkflowEditor; the editor view inside is unchanged.
import React from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useToastStore } from '../../stores/toastStore'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useT } from '../../i18n'
import { useWcvSuppression } from '../useWcvSuppression'
import WorkflowEditorView from './WorkflowEditorView'
import { MemoryPane } from '../workspace/MemoryPane'
import './workflowEditor.css'

/** RF-03: mirrors WorkflowEditorView's editable-target test (Esc must blur a field, not close). */
const inEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable)

export function WorkflowEditorOverlay({
  profileId
}: {
  profileId: string
}): React.JSX.Element | null {
  const open = useUiStore((s) => s.workflowEditorOpen)
  const close = useUiStore((s) => s.closeWorkflowEditor)
  const pushToast = useToastStore((s) => s.push)
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
    // RF-03: Esc no longer closes unconditionally. In a text field it blurs (so Esc means "leave
    // this field", not "slam the editor shut"); with unsaved changes it toasts a save reminder and
    // stays open; only a clean canvas closes on Esc. The ✕ button remains an unconditional close.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (inEditable(e.target)) {
        ;(e.target as HTMLElement).blur()
        return
      }
      if (useWorkflowEditorStore.getState().dirty) {
        pushToast(t('workflowEditor.escUnsaved'))
        return
      }
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, pushToast, t])

  if (!open) return null

  return (
    <div className="rpt-wfe-overlay">
      <div className="rpt-wfe-overlay-header">
        <strong className="rpt-wfe-overlay-title">{t('workflowEditor.viewTitle')}</strong>
        <span className="rpt-wfe-spacer" />
        <button
          type="button"
          onClick={() => setMemoryOpen((v) => !v)}
          title={t('workflowEditor.memoryTip')}
          className="rpt-wfe-btn-sm"
        >
          {t('workflowEditor.memory')}
        </button>
        <button
          type="button"
          onClick={close}
          title={`${t('workflowEditor.close')} (Esc)`}
          className="rpt-wfe-overlay-close"
        >
          <span aria-hidden className="rpt-wfe-overlay-close-x">
            ✕
          </span>
          {t('workflowEditor.close')}
        </button>
      </div>
      <div className="rpt-wfe-overlay-body">
        <div className="rpt-wfe-overlay-view">
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
