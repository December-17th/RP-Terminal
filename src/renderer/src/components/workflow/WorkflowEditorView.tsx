// Composition root for the node-workflow editor (Phase 4 task 6): top bar (workflow picker, save,
// clone, import/export, validation status) + a three-column body (node palette / FlowCanvas /
// NodeConfigPanel). Everything is store-driven — this component only wires window.api dialogs and
// the local "is the error list open" UI toggle; all workflow state lives in useWorkflowEditorStore.
//
// No beforeunload-style unsaved-changes guard here: panel switching is in-app (no page navigation
// to intercept), and the `dirty`/`unsaved` chip in the top bar is the guard the user sees instead.
import React, { useEffect, useState } from 'react'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useToastStore } from '../../stores/toastStore'
import { useOptionalT, useT } from '../../i18n'
import FlowCanvas from './FlowCanvas'
import NodeConfigPanel from './NodeConfigPanel'

const BUILTIN_WORKFLOW_ID = 'default'

/** Renders `status` translated when it matches a known workflowEditor.* key (including the
 *  connect.* rejection reasons the store writes as `connect.<reason>`); otherwise shows the raw
 *  string as-is (save() writes raw IPC error text into status on failure). */
function StatusLine({ status }: { status: string | null }): React.JSX.Element | null {
  const t = useT()
  if (!status) return null
  const knownKeys = [
    'saved',
    'saveFailed',
    'connect.incompatible',
    'connect.occupied',
    'connect.self',
    'connect.missing-port'
  ]
  const text = knownKeys.includes(status) ? t(`workflowEditor.${status}`) : status
  return (
    <div style={{ fontSize: 11.5, color: 'var(--rpt-text-secondary)', padding: '2px 10px' }}>
      {text}
    </div>
  )
}

export default function WorkflowEditorView({
  profileId
}: {
  profileId: string
}): React.JSX.Element {
  const t = useT()
  const tOpt = useOptionalT()
  const workflows = useWorkflowEditorStore((s) => s.workflows)
  const currentId = useWorkflowEditorStore((s) => s.currentId)
  const doc = useWorkflowEditorStore((s) => s.doc)
  const setDocName = useWorkflowEditorStore((s) => s.setDocName)
  const dirty = useWorkflowEditorStore((s) => s.dirty)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const errors = useWorkflowEditorStore((s) => s.errors)
  const status = useWorkflowEditorStore((s) => s.status)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const init = useWorkflowEditorStore((s) => s.init)
  const open = useWorkflowEditorStore((s) => s.open)
  const save = useWorkflowEditorStore((s) => s.save)
  const cloneAndEdit = useWorkflowEditorStore((s) => s.cloneAndEdit)
  const select = useWorkflowEditorStore((s) => s.select)

  const [showErrors, setShowErrors] = useState(false)

  useEffect(() => {
    void init(profileId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per profileId, init is stable
  }, [profileId])

  useEffect(() => {
    if (!currentId && workflows.length > 0) {
      const fallback = workflows.some((w) => w.id === BUILTIN_WORKFLOW_ID)
        ? BUILTIN_WORKFLOW_ID
        : workflows[0].id
      void open(profileId, fallback)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open/profileId intentionally excluded to avoid re-triggering on store identity churn
  }, [workflows, currentId])

  const onImport = async (): Promise<void> => {
    const result = await window.api.importWorkflowDialog(profileId)
    if (result === null) return
    if (!result.ok) {
      useToastStore.getState().push(`${t('workflowEditor.importFailed')}: ${result.error}`)
      return
    }
    await init(profileId)
  }

  const onExport = (): void => {
    if (!currentId) return
    const name = workflows.find((w) => w.id === currentId)?.name ?? currentId
    void window.api.exportWorkflowDialog(profileId, currentId, name)
  }

  return (
    <div className="rpt-workflow-editor" style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid var(--rpt-border)',
          flex: '0 0 auto'
        }}
      >
        <select
          value={currentId ?? ''}
          onChange={(e) => void open(profileId, e.target.value)}
          style={{ fontSize: 12.5 }}
        >
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        {/* Rename the open workflow (doc metadata; persists on Save). Read-only for the builtin. */}
        <input
          type="text"
          value={doc?.name ?? ''}
          disabled={readOnly}
          placeholder={t('workflowEditor.namePh')}
          title={t('workflowEditor.nameTitle')}
          onChange={(e) => setDocName(e.target.value)}
          style={{ fontSize: 12.5, width: 170 }}
        />

        <button
          type="button"
          disabled={readOnly || !dirty}
          onClick={() => void save(profileId)}
          style={{ fontSize: 12.5 }}
        >
          {t('workflowEditor.save')}
        </button>

        {dirty && (
          <span
            style={{
              fontSize: 11,
              padding: '1px 8px',
              borderRadius: 10,
              border: '1px solid var(--rpt-warning)',
              color: 'var(--rpt-warning)'
            }}
          >
            {t('workflowEditor.unsaved')}
          </span>
        )}

        <button
          type="button"
          onClick={() => void cloneAndEdit(profileId)}
          style={{ fontSize: 12.5 }}
        >
          {t('workflowEditor.cloneToEdit')}
        </button>

        <button type="button" onClick={() => void onImport()} style={{ fontSize: 12.5 }}>
          {t('workflowEditor.import')}
        </button>

        <button type="button" disabled={!currentId} onClick={onExport} style={{ fontSize: 12.5 }}>
          {t('workflowEditor.export')}
        </button>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          onClick={() => setShowErrors((v) => !v)}
          style={{
            fontSize: 11,
            padding: '2px 9px',
            borderRadius: 10,
            border: `1px solid ${errors.length === 0 ? 'var(--rpt-success)' : 'var(--rpt-danger)'}`,
            color: errors.length === 0 ? 'var(--rpt-success)' : 'var(--rpt-danger)',
            background: 'transparent'
          }}
        >
          {errors.length === 0
            ? t('workflowEditor.valid')
            : `${t('workflowEditor.invalid')} (${errors.length})`}
        </button>
      </div>

      {showErrors && errors.length > 0 && (
        <div
          style={{
            flex: '0 0 auto',
            borderBottom: '1px solid var(--rpt-border)',
            padding: '6px 10px',
            fontSize: 11.5
          }}
        >
          <div style={{ color: 'var(--rpt-text-tertiary)', marginBottom: 4 }}>
            {t('workflowEditor.errors')}
          </div>
          {errors.map((err, i) => {
            // Localized label for the error CODE; the raw message keeps the specifics (port
            // names etc.) as the detail.
            const label = tOpt(`workflowEditor.err.${err.code}`)
            return (
              <div
                key={i}
                onClick={() => err.nodeId && select(err.nodeId)}
                style={{
                  cursor: err.nodeId ? 'pointer' : 'default',
                  color: 'var(--rpt-danger)',
                  padding: '2px 0'
                }}
              >
                {label ? `${label} — ` : ''}
                {err.message}
                {err.nodeId ? ` (${err.nodeId})` : ''}
              </div>
            )
          })}
        </div>
      )}

      {readOnly && (
        <div
          style={{
            flex: '0 0 auto',
            padding: '5px 10px',
            fontSize: 11.5,
            color: 'var(--rpt-warning)',
            borderBottom: '1px solid var(--rpt-border)'
          }}
        >
          {t('workflowEditor.readOnlyBuiltin')}
        </div>
      )}

      <StatusLine status={status} />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 180,
            flex: '0 0 180px',
            overflowY: 'auto',
            borderRight: '1px solid var(--rpt-border)',
            padding: 6
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--rpt-text-tertiary)',
              marginBottom: 6
            }}
          >
            {t('workflowEditor.palette')}
          </div>
          {nodeTypes.map((nt) => {
            const title = tOpt(`workflowEditor.nodeTitle.${nt.type}`) || nt.title
            const desc = tOpt(`workflowEditor.nodeDesc.${nt.type}`)
            return (
              <div
                key={nt.type}
                draggable
                title={desc}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/rpt-node-type', nt.type)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                style={{
                  border: '1px solid var(--rpt-border)',
                  borderRadius: 6,
                  padding: '5px 8px',
                  marginBottom: 5,
                  cursor: 'grab',
                  background: 'var(--rpt-bg-elevated)'
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--rpt-text-primary)' }}>{title}</div>
                <div style={{ fontSize: 10, color: 'var(--rpt-text-tertiary)' }}>{nt.type}</div>
                {desc && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--rpt-text-secondary)',
                      marginTop: 3,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden'
                    }}
                  >
                    {desc}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <FlowCanvas profileId={profileId} />
        </div>

        <div
          style={{
            width: 280,
            flex: '0 0 280px',
            overflowY: 'auto',
            borderLeft: '1px solid var(--rpt-border)',
            padding: 8
          }}
        >
          <NodeConfigPanel profileId={profileId} />
        </div>
      </div>
    </div>
  )
}
