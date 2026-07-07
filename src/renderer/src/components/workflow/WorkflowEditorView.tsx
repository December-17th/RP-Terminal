// Composition root for the node-workflow editor (Phase 4 task 6; one-canvas rebuild WP6.4a): top bar
// (workflow picker, save, clone, import/export, validation status) + a three-column body (node palette /
// FlowCanvas / NodeConfigPanel) + a collapsible Run drawer at the bottom. Everything is store-driven —
// this component only wires window.api dialogs, the local "is the error list open" UI toggle, and the
// run-replay selection; all workflow state lives in useWorkflowEditorStore.
//
// One-canvas rebuild WP6.4a: Effective mode is RETIRED from the editor (the mode toggle, the
// EffectiveCanvas branch, the effectiveGraphStore projection, and the pack lock/router wiring are gone).
// The store's lock/router FIELDS stay (dead) until WP6.6; the VIEW simply no longer drives them. The
// editor is now always the single authoring canvas.
//
// No beforeunload-style unsaved-changes guard here: panel switching is in-app (no page navigation
// to intercept), and the `dirty`/`unsaved` chip in the top bar is the guard the user sees instead.
import React, { useEffect, useMemo, useState } from 'react'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useToastStore } from '../../stores/toastStore'
import { useUiStore } from '../../stores/uiStore'
import { useOptionalT, useT } from '../../i18n'
import type { WorkflowRunTrace } from '../../../../shared/workflow/trace'
import FlowCanvas from './FlowCanvas'
import NodeConfigPanel from './NodeConfigPanel'
import RunDrawer from './RunDrawer'
import ModuleImportSheet, { type ModuleInspectReport } from './ModuleImportSheet'

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
  const sessionType = useWorkflowEditorStore((s) => s.sessionType)
  const errors = useWorkflowEditorStore((s) => s.errors)
  const status = useWorkflowEditorStore((s) => s.status)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const init = useWorkflowEditorStore((s) => s.init)
  const open = useWorkflowEditorStore((s) => s.open)
  const openFragment = useWorkflowEditorStore((s) => s.openFragment)
  const save = useWorkflowEditorStore((s) => s.save)
  const cloneAndEdit = useWorkflowEditorStore((s) => s.cloneAndEdit)
  const select = useWorkflowEditorStore((s) => s.select)
  // WP6.3: the on-canvas grouping affordance. The toolbar shows "Group into module" when ≥2
  // ungrouped nodes are multi-selected (the store's groupSelection enforces the same rule; this
  // just gates the button's visibility).
  const selectedNodeIds = useWorkflowEditorStore((s) => s.selectedNodeIds)
  const groupSelection = useWorkflowEditorStore((s) => s.groupSelection)
  const insertModule = useWorkflowEditorStore((s) => s.insertModule)
  const canGroup = useMemo(() => {
    if (selectedNodeIds.length < 2) return false
    const grouped = new Set((doc?.groups ?? []).flatMap((g) => g.nodeIds))
    return !selectedNodeIds.some((id) => grouped.has(id))
  }, [selectedNodeIds, doc])

  const [showErrors, setShowErrors] = useState(false)
  // WP6.5: the module-import review sheet. Null when closed; holds the inspection report while open.
  const [moduleReport, setModuleReport] = useState<ModuleInspectReport | null>(null)

  // WP4.4: a fragment-editing hand-off ("Edit fragment in Studio"). Read the requested pack id ONCE on
  // mount (a ref so a later store change can't retrigger the load).
  const requestedFragmentPackId = useUiStore((s) => s.workflowEditorFragmentPackId)
  const consumeFragmentPackId = useUiStore((s) => s.consumeWorkflowEditorFragmentPackId)
  const initialFragmentPackId = React.useRef(requestedFragmentPackId).current

  // WP6.4a: run replay. Clicking a Run-drawer entry loads its trace here; FlowCanvas paints it via
  // `traceOverride` instead of the live last-run overlay. Cleared on a doc/chat switch or the "live" reset.
  const [replayTrace, setReplayTrace] = useState<WorkflowRunTrace | null>(null)
  // A monotonically-bumped token the drawer + trigger badges watch to refetch after a save.
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    void (async () => {
      await init(profileId)
      // WP4.4: after node types are loaded (openFragment validates against them), load the requested
      // pack fragment as an editable session. Consume the request so a manual re-open starts normally;
      // a load failure (uninstalled pack) toasts + falls back to the default workflow open below.
      if (initialFragmentPackId) {
        const res = await openFragment(profileId, initialFragmentPackId)
        consumeFragmentPackId()
        if (!res.ok) useToastStore.getState().push(t('workflowEditor.fragmentLoadFailed'))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per profileId; init/openFragment stable
  }, [profileId])

  // A doc switch clears any active replay (its node ids may not exist in the new doc).
  useEffect(() => {
    setReplayTrace(null)
  }, [currentId])

  useEffect(() => {
    // Don't auto-open the default workflow when a fragment session was requested — its async load sets
    // currentId to the pack id; racing a default open would clobber the fragment session (WP4.4).
    if (initialFragmentPackId) return
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

  // WP6.5: open the module-import dialog + inspect, then show the review sheet. Canceled dialog → no-op.
  const onImportModule = async (): Promise<void> => {
    const report = await window.api.importModuleDialog(profileId)
    if (report === null) return
    setModuleReport(report as ModuleInspectReport)
  }

  // Install the inspected module: confirm main-side (installs bundled templates + returns the payload),
  // then insert it into the edited doc at a viewport-center-ish position (best-effort — the editor view
  // is outside the ReactFlow context). Insertion marks the doc dirty; the user saves it themselves.
  const onInstallModule = async (token: string): Promise<void> => {
    setModuleReport(null)
    const result = await window.api.confirmModuleImport(token)
    if (!result.ok) {
      useToastStore.getState().push(t('workflowEditor.moduleImport.installFailed'))
      return
    }
    insertModule(result.module, { x: 220, y: 200 })
    useToastStore.getState().push(t('workflowEditor.moduleImport.installed'))
  }

  const onCancelModule = (): void => {
    if (moduleReport?.token) void window.api.cancelModuleImport(moduleReport.token)
    setModuleReport(null)
  }

  // Save the currently-open doc, then bump the refresh token so the Run drawer + the live trigger
  // badges refetch (a save can change which triggers exist / are enabled).
  const onSave = async (): Promise<void> => {
    await save(profileId)
    setRefreshToken((n) => n + 1)
  }

  return (
    <div
      className="rpt-workflow-editor"
      style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}
    >
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
        {/* A fragment-editing session (WP4.4): the workflow picker is replaced by a
            "editing pack fragment: <name>" badge so the user knows which artifact they're in. */}
        {sessionType === 'fragment' ? (
          <span
            className="rpt-workflow-fragment-badge"
            style={{
              fontSize: 11.5,
              padding: '2px 9px',
              borderRadius: 10,
              border: '1px solid var(--rpt-agent-region-border)',
              background: 'var(--rpt-agent-region)',
              color: 'var(--rpt-agent-region-text)'
            }}
            title={t('workflowEditor.fragmentBadgeTitle')}
          >
            {t('workflowEditor.fragmentBadge', { name: doc?.name ?? currentId ?? '' })}
          </span>
        ) : (
          <>
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
          </>
        )}

        <button
          type="button"
          disabled={readOnly || !dirty}
          onClick={() => void onSave()}
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

        {/* Clone / import / export are WORKFLOW-FILE operations (they read currentId as a workflow id).
            In a fragment session currentId is a pack id, so these are hidden. */}
        {sessionType !== 'fragment' && (
          <>
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
          </>
        )}

        {/* WP6.3: group the current multi-selection into an on-canvas module (≥2 unlocked, ungrouped). */}
        {sessionType !== 'fragment' && canGroup && (
          <button type="button" onClick={() => groupSelection()} style={{ fontSize: 12.5 }}>
            {t('workflowEditor.groupSelection')}
          </button>
        )}

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

          {/* Reusable sub-graph packages the author can drop as one subgraph.call node,
              preconfigured with workflow_id (sub-graph nodes v1 plan §5). Excludes the doc
              currently open (no self-reference from the palette; the run-time recursion guard
              would refuse it anyway). */}
          {workflows.some((w) => w.kind === 'subgraph' && w.id !== currentId) && (
            <>
              <div
                style={{
                  fontSize: 10.5,
                  color: 'var(--rpt-text-tertiary)',
                  margin: '10px 0 6px',
                  borderTop: '1px solid var(--rpt-border)',
                  paddingTop: 8
                }}
              >
                {t('workflowEditor.subgraphs')}
              </div>
              {workflows
                .filter((w) => w.kind === 'subgraph' && w.id !== currentId)
                .map((w) => (
                  <div
                    key={w.id}
                    style={{
                      border: '1px solid var(--rpt-border)',
                      borderRadius: 6,
                      padding: '5px 8px',
                      marginBottom: 5,
                      background: 'var(--rpt-bg-elevated)'
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--rpt-text-primary)' }}>{w.name}</div>
                    {/* Two draggable type chips: drop as a plain subgraph.call, or as a
                        subgraph.loop — both carry the same workflow_id payload. */}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      {(['subgraph.call', 'subgraph.loop'] as const).map((nodeType) => (
                        <div
                          key={nodeType}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/rpt-node-type', nodeType)
                            e.dataTransfer.setData('application/rpt-subgraph-id', w.id)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          style={{
                            border: '1px solid var(--rpt-border)',
                            borderRadius: 4,
                            padding: '2px 6px',
                            cursor: 'grab',
                            fontSize: 10,
                            color: 'var(--rpt-text-tertiary)',
                            background: 'var(--rpt-bg-tertiary)'
                          }}
                        >
                          {t(`workflowEditor.nodeTitle.${nodeType}`)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </>
          )}

          {/* WP6.5: the Modules section — import a `.rptmodule` file into the open doc. A fragment
              session's currentId is a pack id (not a doc file), but a fragment IS a doc you can splice a
              module into, so this is offered in both session kinds. */}
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--rpt-text-tertiary)',
              margin: '10px 0 6px',
              borderTop: '1px solid var(--rpt-border)',
              paddingTop: 8
            }}
          >
            {t('workflowEditor.modules')}
          </div>
          <button
            type="button"
            disabled={readOnly}
            onClick={() => void onImportModule()}
            style={{ fontSize: 12, width: '100%' }}
          >
            {t('workflowEditor.importModule')}
          </button>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <FlowCanvas
              profileId={profileId}
              traceOverride={replayTrace}
              triggerRefreshToken={refreshToken}
              onManualRun={() => setRefreshToken((n) => n + 1)}
            />
          </div>
          {/* WP6.4a: the Run drawer — a collapsible strip along the bottom of the canvas column. */}
          <RunDrawer
            profileId={profileId}
            refreshToken={refreshToken}
            onReplay={setReplayTrace}
            replayTrace={replayTrace}
          />
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

      {/* WP6.5: the module-import review sheet (centered over the editor). */}
      {moduleReport && (
        <ModuleImportSheet
          report={moduleReport}
          onInstall={(token) => void onInstallModule(token)}
          onCancel={onCancelModule}
        />
      )}
    </div>
  )
}
