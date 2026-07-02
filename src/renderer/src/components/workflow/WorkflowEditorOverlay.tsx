// Full-screen host for the workflow editor (owner feedback: the canvas needs the whole window,
// not a workspace panel). Rendered once at the App level next to SettingsModal, toggled via
// useUiStore.openWorkflowEditor/closeWorkflowEditor; the editor view inside is unchanged.
import React from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n'
import WorkflowEditorView from './WorkflowEditorView'

export function WorkflowEditorOverlay({
  profileId
}: {
  profileId: string
}): React.JSX.Element | null {
  const open = useUiStore((s) => s.workflowEditorOpen)
  const close = useUiStore((s) => s.closeWorkflowEditor)
  const t = useT()
  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--rpt-bg-primary)'
      }}
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
        <strong style={{ fontSize: 13 }}>{t('workflowEditor.viewTitle')}</strong>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={close} style={{ fontSize: 12.5 }}>
          {t('workflowEditor.close')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WorkflowEditorView profileId={profileId} />
      </div>
    </div>
  )
}
