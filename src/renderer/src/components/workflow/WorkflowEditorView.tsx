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
import AgentsDropdown from './AgentsDropdown'
import { isAgentGroup, ungroupedTriggerChains } from './agentModel'
import { groupPalette, paletteMatch } from './paletteModel'
import type { EditorNodeType } from './editorModel'
import './workflowEditor.css'

/** ModuleTemplateSummary mirror (main's moduleTemplates.ts) — redeclared locally per the preload
 *  convention (the renderer only sees this over IPC and must not import from src/main). */
interface LibraryEntry {
  id: string
  name: string
  description?: string
  nodeCount: number
  source: 'builtin' | 'user'
}

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
  // Active narrator (feat/active-workflow-picker): the id of the global narrator that runs at
  // generation (workflowService resolves `selection.worlds[world] ?? selection.global`). The header
  // shows a badge when the open doc IS it, else a "set as active" button; the picker marks it too.
  const activeGlobalId = useWorkflowEditorStore((s) => s.activeGlobalId)
  const setActiveGlobal = useWorkflowEditorStore((s) => s.setActiveGlobal)
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
  // WP-D (spec §4): the "Collapse all agents / Expand all" toolbar cluster is offered only when the doc
  // has ≥1 agent group (a named group rooted at a trigger node — the agent UI contract).
  const editorNodes = useWorkflowEditorStore((s) => s.nodes)
  const editorEdges = useWorkflowEditorStore((s) => s.edges)
  const collapseAllAgents = useWorkflowEditorStore((s) => s.collapseAllAgents)
  const expandAllGroups = useWorkflowEditorStore((s) => s.expandAllGroups)
  const autoGroupTriggerChains = useWorkflowEditorStore((s) => s.autoGroupTriggerChains)
  const hasAgentGroups = useMemo(() => {
    const groups = doc?.groups ?? []
    if (groups.length === 0) return false
    const types = new Map<string, EditorNodeType>(nodeTypes.map((n) => [n.type, n]))
    return groups.some((g) => isAgentGroup(editorNodes, g, types))
  }, [doc, editorNodes, nodeTypes])
  // WP-D (spec §4): the auto-group affordance. A `.rptflow` import lands ungrouped and has no review
  // sheet (a module import already groups via insertModule), so we offer one-click grouping of every
  // ungrouped trigger chain from the toolbar once such a doc is open in the editor.
  const hasUngroupedChains = useMemo(() => {
    const groups = doc?.groups ?? []
    const types = new Map<string, EditorNodeType>(nodeTypes.map((n) => [n.type, n]))
    return ungroupedTriggerChains(editorNodes, editorEdges, groups, types).length > 0
  }, [doc, editorNodes, editorEdges, nodeTypes])

  // feat/active-workflow-picker: only a runnable NARRATOR (turn) doc can be the active global narrator.
  // A fragment session edits a pack fragment (never a workflow file); a sub-graph doc is a callable
  // package that resolveWorkflowDoc refuses — both are excluded from the set-active control. The
  // picker's summary carries `kind` ('subgraph' vs turn/undefined).
  const openIsSubgraph = workflows.find((w) => w.id === currentId)?.kind === 'subgraph'
  const canSetActive = sessionType !== 'fragment' && !openIsSubgraph && !!currentId
  const openIsActiveNarrator = !!currentId && currentId === activeGlobalId

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
  // WP-G (spec §2): the palette's Agent library (built-in templates + the user library) + the search
  // box that filters BOTH palette sections.
  const [libraryEntries, setLibraryEntries] = useState<LibraryEntry[]>([])
  const refreshLibrary = React.useCallback(async (): Promise<void> => {
    try {
      const list = (await window.api.listModuleTemplates(profileId)) as LibraryEntry[]
      setLibraryEntries(list ?? [])
    } catch {
      setLibraryEntries([])
    }
  }, [profileId])
  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

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
    // The builtin default doc is no longer a list entry (it's an invisible fallback), so auto-open the
    // first listed doc — the seeded, editable "Default" once the profile has been seeded.
    if (!currentId && workflows.length > 0) {
      void open(profileId, workflows[0].id)
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
  const onInstallModule = async (token: string, saveToLibrary: boolean): Promise<void> => {
    setModuleReport(null)
    const result = await window.api.confirmModuleImport(token)
    if (!result.ok) {
      useToastStore.getState().push(t('workflowEditor.moduleImport.installFailed'))
      return
    }
    // RF-04: insert at the viewport center via the canvas API (closes the parked "module insertion at
    // viewport center" item); falls back to {x:220,y:200} before the canvas has reported ready.
    // WP-G: stamp origin:'import' so the Agents ▾ shows the `imported` chip for a file-imported module.
    insertModule(result.module, canvasApi.current?.centerPosition() ?? { x: 220, y: 200 }, {
      origin: 'import'
    })
    useToastStore.getState().push(t('workflowEditor.moduleImport.installed'))
    // WP-G (spec §2): "an imported module can be saved into the user library for reuse". Fail-soft —
    // a library-save failure never blocks the insert (the module is already on the canvas).
    if (saveToLibrary) {
      const saved = await window.api.saveModuleToLibrary(profileId, result.module)
      if (saved.ok) {
        useToastStore.getState().push(t('workflowEditor.library.saved'))
        void refreshLibrary()
      } else {
        useToastStore.getState().push(t('workflowEditor.library.saveFailed'))
      }
    }
  }

  // WP-G: insert a library template — fetch the payload, land it at a free spot right of the graph
  // (insertModule remints ids + pre-groups collapsed; no origin stamp — a template is not an import).
  const onInsertTemplate = async (id: string): Promise<void> => {
    const payload = await window.api.getModuleTemplate(profileId, id)
    if (!payload) {
      useToastStore.getState().push(t('workflowEditor.library.insertFailed'))
      return
    }
    const nodes = useWorkflowEditorStore.getState().nodes
    const freeSpot = {
      x: nodes.length > 0 ? Math.max(...nodes.map((n) => n.position.x)) + 320 : 200,
      y: 200
    }
    const groupId = insertModule(payload, freeSpot)
    if (!groupId) useToastStore.getState().push(t('workflowEditor.library.insertFailed'))
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
                  {/* Mark the active global narrator so it's discoverable which doc runs (option
                      markup can't be styled, so it's a text marker). */}
                  {w.id === activeGlobalId ? `● ${w.name}` : w.name}
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

        {/* feat/active-workflow-picker: the active-global-narrator affordance for the open doc.
            Hidden in a fragment/sub-graph session (canSetActive) — only a runnable turn doc can be
            the active narrator. Badge when this doc is already active, else a set-active button that
            flips the badge via the store. */}
        {canSetActive &&
          (openIsActiveNarrator ? (
            <span className="rpt-wfe-active-badge" title={t('workflowEditor.activeNarratorTitle')}>
              {t('workflowEditor.activeNarrator')}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => currentId && void setActiveGlobal(profileId, currentId)}
              title={t('workflowEditor.setActiveNarratorTitle')}
              className="rpt-wfe-btn-sm"
            >
              {t('workflowEditor.setActiveNarrator')}
            </button>
          ))}

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

        {/* WP-D: collapse/expand every agent group on the canvas. */}
        {sessionType !== 'fragment' && hasAgentGroups && !readOnly && (
          <>
            <button
              type="button"
              onClick={() => collapseAllAgents()}
              className="rpt-wfe-btn-sm"
            >
              {t('workflowEditor.collapseAllAgents')}
            </button>
            <button type="button" onClick={() => expandAllGroups()} className="rpt-wfe-btn-sm">
              {t('workflowEditor.expandAll')}
            </button>
          </>
        )}

        {/* WP-D: one-click group every ungrouped trigger chain (the .rptflow-open path). */}
        {sessionType !== 'fragment' && hasUngroupedChains && !readOnly && (
          <button
            type="button"
            onClick={() => autoGroupTriggerChains()}
            className="rpt-wfe-btn-sm"
          >
            {t('workflowEditor.groupAgentChains')}
          </button>
        )}

        {/* WP-F: the Agents ▾ master dropdown (one row per agent; renders null when there are none). */}
        {sessionType !== 'fragment' && <AgentsDropdown profileId={profileId} />}

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
          {/* WP-G (spec §2) + RF-04: ONE search box filters BOTH the Agent library and the
              categorized node list. Same card markup + drag behavior as before; click-to-add lands
              at the (jittered) viewport center. */}
          <input
            type="search"
            className="rpt-wfe-palette-search"
            value={paletteQuery}
            placeholder={t('workflowEditor.paletteSearch')}
            onChange={(e) => setPaletteQuery(e.target.value)}
          />

          {/* WP-G (spec §2): the Agent library — built-in module templates + the user library, with
              "Import module…" as the section's last entry. Click inserts pre-grouped/named/collapsed
              (insertModule remints ids); names/descriptions are module content, shown as-is. */}
          <div className="rpt-wfe-palette-head">{t('workflowEditor.agentLibrary')}</div>
          {libraryEntries
            .filter((entry) => paletteMatch(paletteQuery, [entry.name, entry.description]))
            .map((entry) => (
              <div
                key={entry.id}
                role="button"
                title={entry.description}
                onClick={() => {
                  if (!readOnly) void onInsertTemplate(entry.id)
                }}
                style={{
                  border: '1px solid var(--rpt-agent-region-border)',
                  borderRadius: 6,
                  padding: '5px 8px',
                  marginBottom: 5,
                  cursor: readOnly ? 'default' : 'pointer',
                  opacity: readOnly ? 0.55 : 1,
                  background: 'var(--rpt-agent-region)'
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--rpt-text-primary)' }}>{entry.name}</div>
                <div style={{ fontSize: 10, color: 'var(--rpt-text-tertiary)' }}>
                  {t('workflowEditor.moduleImport.nodeCount', { n: entry.nodeCount })}
                  {entry.source === 'user' ? ` · ${t('workflowEditor.library.user')}` : ''}
                </div>
              </div>
            ))}
          <button
            type="button"
            disabled={readOnly}
            onClick={() => void onImportModule()}
            className="rpt-wfe-import-module-btn"
          >
            {t('workflowEditor.importModule')}
          </button>

          {/* RF-04: the categorized node palette (groupPalette), search-filtered by the same box. */}
          <div className="rpt-wfe-palette-section">{t('workflowEditor.palette')}</div>
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

          {/* WP-G: the WP6.5 "Modules" import section is folded into the Agent library above
              ("Import module…" is that section's last entry, spec §2). A fragment session's currentId
              is a pack id (not a doc file), but a fragment IS a doc you can splice a module into, so the
              importer is offered in both session kinds. */}
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
          onInstall={(token, saveToLibrary) => void onInstallModule(token, saveToLibrary)}
          onCancel={onCancelModule}
        />
      )}
    </div>
  )
}
