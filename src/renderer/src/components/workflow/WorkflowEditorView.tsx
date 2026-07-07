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
import { groupPalette } from './paletteModel'
import './workflowEditor.css'

const BUILTIN_WORKFLOW_ID = 'default'

/** RF-04: ±40px random offset so repeated click-to-add doesn't stack nodes exactly on top of one
 *  another at the viewport center. */
const jitter = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: p.x + (Math.random() - 0.5) * 80,
  y: p.y + (Math.random() - 0.5) * 80
})

/** RF-03: true when the event target is a text-entry surface, so canvas keyboard shortcuts (undo /
 *  redo) don't hijack typing in a config field / rename input. */
const inEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable)

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
  return <div className="rpt-wfe-statusline">{text}</div>
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
  const addNode = useWorkflowEditorStore((s) => s.addNode)
  // RF-03: undo/redo + derived enablement (plain length reads; the store keeps past/future).
  const undo = useWorkflowEditorStore((s) => s.undo)
  const redo = useWorkflowEditorStore((s) => s.redo)
  const canUndo = useWorkflowEditorStore((s) => s.past.length > 0)
  const canRedo = useWorkflowEditorStore((s) => s.future.length > 0)
  const canGroup = useMemo(() => {
    if (selectedNodeIds.length < 2) return false
    const grouped = new Set((doc?.groups ?? []).flatMap((g) => g.nodeIds))
    return !selectedNodeIds.some((id) => grouped.has(id))
  }, [selectedNodeIds, doc])

  const [showErrors, setShowErrors] = useState(false)
  // RF-04: palette search query (substring over type id + localized title) and the canvas API handle
  // (set once via FlowCanvas.onReady; lets this out-of-context view insert at the viewport center).
  const [paletteQuery, setPaletteQuery] = useState('')
  const canvasApi = React.useRef<{ centerPosition: () => { x: number; y: number } } | null>(null)
  // A stable place to insert a click-added node: the canvas center when available, else a sane default.
  const centerPosition = (): { x: number; y: number } =>
    canvasApi.current?.centerPosition() ?? { x: 220, y: 200 }
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
    // RF-04: insert at the viewport center via the canvas API (closes the parked "module insertion at
    // viewport center" item); falls back to {x:220,y:200} before the canvas has reported ready.
    insertModule(result.module, canvasApi.current?.centerPosition() ?? { x: 220, y: 200 })
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

  // RF-03: canvas keyboard shortcuts (the view only mounts while the overlay is open). Ctrl/Cmd+S
  // saves (always swallowed so the browser Save dialog never fires); undo/redo fire only when focus
  // is NOT in a text field (typing an undo-shortcut in a config box must stay text-editing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        if (!readOnly && dirty) void onSave()
        return
      }
      if (inEditable(e.target)) return
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSave is a fresh closure each render; readOnly/dirty/undo/redo are the meaningful deps
  }, [readOnly, dirty, undo, redo])

  return (
    <div className="rpt-workflow-editor">
      <div className="rpt-wfe-topbar">
        {/* A fragment-editing session (WP4.4): the workflow picker is replaced by a
            "editing pack fragment: <name>" badge so the user knows which artifact they're in. */}
        {sessionType === 'fragment' ? (
          <span
            className="rpt-workflow-fragment-badge rpt-wfe-fragment-badge"
            title={t('workflowEditor.fragmentBadgeTitle')}
          >
            {t('workflowEditor.fragmentBadge', { name: doc?.name ?? currentId ?? '' })}
          </span>
        ) : (
          <>
            <select
              value={currentId ?? ''}
              onChange={(e) => void open(profileId, e.target.value)}
              className="rpt-wfe-btn-sm"
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
              className="rpt-wfe-name-input"
            />
          </>
        )}

        <button
          type="button"
          disabled={readOnly || !dirty}
          onClick={() => void onSave()}
          className="rpt-wfe-btn-sm"
        >
          {t('workflowEditor.save')}
        </button>

        {/* RF-03: undo / redo. History is session-agnostic, so shown in both workflow and fragment
            sessions. Disabled off the store's past/future depth; the keyboard shortcuts do the same. */}
        <button
          type="button"
          disabled={!canUndo}
          onClick={() => undo()}
          title={`${t('workflowEditor.undo')} (Ctrl+Z)`}
          aria-label={t('workflowEditor.undo')}
          className="rpt-wfe-btn-sm"
        >
          ↶
        </button>
        <button
          type="button"
          disabled={!canRedo}
          onClick={() => redo()}
          title={`${t('workflowEditor.redo')} (Ctrl+Shift+Z)`}
          aria-label={t('workflowEditor.redo')}
          className="rpt-wfe-btn-sm"
        >
          ↷
        </button>

        {dirty && <span className="rpt-wfe-unsaved">{t('workflowEditor.unsaved')}</span>}

        {/* Clone / import / export are WORKFLOW-FILE operations (they read currentId as a workflow id).
            In a fragment session currentId is a pack id, so these are hidden. */}
        {sessionType !== 'fragment' && (
          <>
            <button
              type="button"
              onClick={() => void cloneAndEdit(profileId)}
              className="rpt-wfe-btn-sm"
            >
              {t('workflowEditor.cloneToEdit')}
            </button>

            <button type="button" onClick={() => void onImport()} className="rpt-wfe-btn-sm">
              {t('workflowEditor.import')}
            </button>

            <button type="button" disabled={!currentId} onClick={onExport} className="rpt-wfe-btn-sm">
              {t('workflowEditor.export')}
            </button>
          </>
        )}

        {/* WP6.3: group the current multi-selection into an on-canvas module (≥2 unlocked, ungrouped). */}
        {sessionType !== 'fragment' && canGroup && (
          <button type="button" onClick={() => groupSelection()} className="rpt-wfe-btn-sm">
            {t('workflowEditor.groupSelection')}
          </button>
        )}

        <span className="rpt-wfe-spacer" />

        <button
          type="button"
          onClick={() => setShowErrors((v) => !v)}
          className={`rpt-wfe-validity ${errors.length === 0 ? 'is-valid' : 'is-invalid'}`}
        >
          {errors.length === 0
            ? t('workflowEditor.valid')
            : `${t('workflowEditor.invalid')} (${errors.length})`}
        </button>
      </div>

      {showErrors && errors.length > 0 && (
        <div className="rpt-wfe-error-strip">
          <div className="rpt-wfe-error-strip-head">{t('workflowEditor.errors')}</div>
          {errors.map((err, i) => {
            // Localized label for the error CODE; the raw message keeps the specifics (port
            // names etc.) as the detail.
            const label = tOpt(`workflowEditor.err.${err.code}`)
            return (
              <div
                key={i}
                onClick={() => err.nodeId && select(err.nodeId)}
                className={`rpt-wfe-error-row${err.nodeId ? ' is-clickable' : ''}`}
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
        <div className="rpt-wfe-readonly-strip">{t('workflowEditor.readOnlyBuiltin')}</div>
      )}

      <StatusLine status={status} />

      <div className="rpt-wfe-body">
        <div className="rpt-wfe-palette">
          <div className="rpt-wfe-palette-head">{t('workflowEditor.palette')}</div>
          {/* RF-04: substring search + categorized rendering. Same card markup + drag behavior as
              before; added click-to-add at the (jittered) viewport center. */}
          <input
            type="text"
            className="rpt-wfe-palette-search"
            value={paletteQuery}
            placeholder={t('workflowEditor.paletteSearch')}
            onChange={(e) => setPaletteQuery(e.target.value)}
          />
          {groupPalette(
            nodeTypes,
            paletteQuery,
            (nt) => tOpt(`workflowEditor.nodeTitle.${nt.type}`) || nt.title
          ).map((group) => (
            <React.Fragment key={group.prefix}>
              <div className="rpt-wfe-palette-cat">
                {tOpt(`workflowEditor.cat.${group.prefix}`) || group.prefix}
              </div>
              {group.items.map((nt) => {
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
                    onClick={() => {
                      if (!readOnly) addNode(nt.type, jitter(centerPosition()))
                    }}
                    className="rpt-wfe-palette-card"
                  >
                    <div className="rpt-wfe-palette-card-title">{title}</div>
                    <div className="rpt-wfe-palette-card-type">{nt.type}</div>
                    {desc && <div className="rpt-wfe-palette-card-desc">{desc}</div>}
                  </div>
                )
              })}
            </React.Fragment>
          ))}

          {/* Reusable sub-graph packages the author can drop as one subgraph.call node,
              preconfigured with workflow_id (sub-graph nodes v1 plan §5). Excludes the doc
              currently open (no self-reference from the palette; the run-time recursion guard
              would refuse it anyway). */}
          {workflows.some((w) => w.kind === 'subgraph' && w.id !== currentId) && (
            <>
              <div className="rpt-wfe-palette-section">{t('workflowEditor.subgraphs')}</div>
              {workflows
                .filter((w) => w.kind === 'subgraph' && w.id !== currentId)
                .map((w) => (
                  <div key={w.id} className="rpt-wfe-subgraph-card">
                    <div className="rpt-wfe-palette-card-title">{w.name}</div>
                    {/* Two draggable type chips: drop as a plain subgraph.call, or as a
                        subgraph.loop — both carry the same workflow_id payload. */}
                    <div className="rpt-wfe-subgraph-chips">
                      {(['subgraph.call', 'subgraph.loop'] as const).map((nodeType) => (
                        <div
                          key={nodeType}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/rpt-node-type', nodeType)
                            e.dataTransfer.setData('application/rpt-subgraph-id', w.id)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onClick={() => {
                            // RF-04: click-to-add, mirroring the drop path's { workflow_id } config.
                            if (!readOnly) addNode(nodeType, jitter(centerPosition()), { workflow_id: w.id })
                          }}
                          className="rpt-wfe-subgraph-chip"
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
          <div className="rpt-wfe-palette-section">{t('workflowEditor.modules')}</div>
          <button
            type="button"
            disabled={readOnly}
            onClick={() => void onImportModule()}
            className="rpt-wfe-import-module-btn"
          >
            {t('workflowEditor.importModule')}
          </button>
        </div>

        <div className="rpt-wfe-canvas-col">
          <div className="rpt-wfe-canvas-fill">
            <FlowCanvas
              profileId={profileId}
              traceOverride={replayTrace}
              triggerRefreshToken={refreshToken}
              onManualRun={() => setRefreshToken((n) => n + 1)}
              onReady={(api) => {
                canvasApi.current = api
              }}
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

        <div className="rpt-wfe-config-col">
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
