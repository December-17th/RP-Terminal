// Token-themed React Flow canvas for the node-workflow editor (Phase 4 task 4). Store-driven:
// this component renders FROM useWorkflowEditorStore and dispatches back TO it — it never keeps
// its own copy of nodes/edges (uncontrolled RF state is not acceptable here). See
// src/renderer/src/stores/workflowEditorStore.ts and editorModel.ts (EditorNode/EditorEdge) for
// the source of truth this maps to/from RF's Node<>/Edge<> shapes.
import React, { useCallback, useMemo } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type EdgeChange,
  type Node as RFNode,
  type NodeChange,
  type NodeProps,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './workflowEditor.css'
import { useWorkflowEditorStore, type NodeTypeInfo } from '../../stores/workflowEditorStore'
import { useWorkflowTraceStore } from '../../stores/workflowTraceStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useOptionalT, useT } from '../../i18n'
import {
  formatTraceSeconds,
  type StoredRunRecord,
  type TraceNode,
  type WorkflowRunTrace
} from '../../../../shared/workflow/trace'
import type { EditorNode } from './editorModel'
import type { GroupDecl } from '../../../../shared/workflow/types'
import { collapsedView, groupBounds, MODULE_PORT } from './groupModel'
import {
  agentEnabledState,
  agentStatusSentence,
  agentTriggers,
  describeTriggerNode,
  excerptOf,
  isAgentGroup,
  isTriggerType,
  modeGatedTriggerIds,
  newestRunForGroup,
  promptExcerpt,
  promptTextOfNode,
  type AgentEnabledState,
  type AgentSentence
} from './agentModel'

/** Matches the palette drag payload's mime type (drag source lives in a later task's palette
 *  component; this is the contract both sides must agree on). */
const DRAG_MIME = 'application/rpt-node-type'
/** Second drag payload key, set only when dragging a Sub-graphs palette entry (sub-graph nodes
 *  v1 plan §5): carries the target sub-graph's workflow id, so the dropped `subgraph.call` node
 *  arrives preconfigured with `workflow_id` instead of empty. */
const DRAG_SUBGRAPH_ID_MIME = 'application/rpt-subgraph-id'

/** One trigger node's live explanation (WP6.4a) — from explainDocTriggers, keyed onto the node. */
export interface DocTriggerBadge {
  met: boolean
  current?: number | string | boolean
  required?: number | string | boolean
  description: string
}

interface RptNodeData extends Record<string, unknown> {
  editorNode: EditorNode
  typeInfo: NodeTypeInfo | undefined
  /** This node's outcome in the active chat's LAST run of this workflow (spec §13), if any. */
  trace?: TraceNode
  /** WP6.4a: the live trigger explanation for a trigger.* node (met / now / at), if fetched. */
  triggerBadge?: DocTriggerBadge
  /** RF-01: the "run now" affordance for a `trigger.manual` node. `enabled` folds in docIsActive,
   *  dirty, and the node's own disabled flag; `disabledReason` is a raw CODE (translated in RptNode,
   *  where `t` is available). Only populated for `trigger.manual` nodes. */
  manualRun?: { enabled: boolean; disabledReason: 'saveFirst' | 'inactiveDoc' | null; run: () => Promise<void> }
  /** Owner manual-pass fix: this trigger's every out-edge dead-ends in a non-selected control.mode
   *  slot (modeGatedTriggerIds) — rendered dimmed + a "gated by mode" chip, visually DISTINCT from
   *  disabled (user-toggled-off). Display only; the switch stays an independent master toggle. */
  modeGated?: boolean
}

/** Maps a PortType to the CSS class workflowEditor.css keys its color off. Falls back to `Any`'s
 *  (neutral) styling for unknown/legacy port type strings so a catalog drift can't crash render. */
function portTypeClass(type: string | undefined): string {
  switch (type) {
    case 'Messages':
    case 'Text':
    case 'Vars':
    case 'Context':
    case 'Lore':
    case 'Prompt':
    case 'Signal':
    case 'Error':
    case 'Floors':
    case 'Any':
      return `rpt-port-${type.toLowerCase()}`
    default:
      return 'rpt-port-any'
  }
}

function RptNode({ data, selected }: NodeProps<RFNode<RptNodeData>>): React.JSX.Element {
  const t = useT()
  const tOpt = useOptionalT()
  const setNodeDisabled = useWorkflowEditorStore((s) => s.setNodeDisabled)
  const { editorNode, typeInfo, trace, triggerBadge, manualRun, modeGated } = data
  // RF-01: disable the ▶ button while its headless run is in flight (no spinner — just guard).
  const [running, setRunning] = React.useState(false)
  const inputs = typeInfo?.inputs ?? []
  const outputs = typeInfo?.outputs ?? []
  const disabled = editorNode.disabled === true
  // Trigger detection keys off the catalog's `isTrigger` flag (surfaced through list-node-types in
  // WP-A), so any node type that opts in — not just `trigger.*` — gets the on/off switch. The name
  // prefix is kept ONLY as a fallback for a stale/absent catalog entry.
  const isTrigger = typeInfo?.isTrigger ?? editorNode.type.startsWith('trigger.')
  // Localized node title with the catalog's English title as the fallback.
  const title =
    tOpt(`workflowEditor.nodeTitle.${editorNode.type}`) || typeInfo?.title || editorNode.type
  const traceTitle = trace
    ? `${trace.failedOpen ? t('workflow.trace.status.failedOpen') : t(`workflow.trace.status.${trace.status}`)}${trace.ms !== undefined ? ` · ${formatTraceSeconds(trace.ms)}` : ''}${trace.error ? ` — ${trace.error.message}` : ''}${trace.failedOpen ? ` — ${t('workflow.trace.failedOpenTip')}` : ''}`
    : undefined
  // WP-D (spec §4): on-card prompt excerpt for an ungrouped prompt-bearing node (agent.llm etc.) —
  // the first system row's text, 2 lines. Derived via the WP-A `promptFields` hint.
  const promptText = typeInfo
    ? promptTextOfNode(editorNode, new Map([[editorNode.type, typeInfo]]))
    : null

  return (
    <div
      className={`rpt-node${selected ? ' selected' : ''}${editorNode.isMainOutput ? ' is-main-output' : ''}${trace ? ` rpt-node-trace-${trace.status}` : ''}${disabled ? ' rpt-node-disabled' : ''}${modeGated && !disabled ? ' rpt-node-mode-gated' : ''}`}
    >
      <div className="rpt-node-title-row">
        {editorNode.isMainOutput && (
          <span className="rpt-node-main-badge" title={t('workflowEditor.mainOutput')}>
            ★
          </span>
        )}
        <span className="rpt-node-title">{title}</span>
        <span className="rpt-node-type-id">{editorNode.type}</span>
        {/* Owner manual-pass fix: this trigger's chain is dead-ended by the current control.mode
            selection — dim + chip (distinct from disabled: solid border, warning-tinted chip, and the
            switch stays interactive: it is an independent master toggle, not what the mode writes). */}
        {modeGated && !disabled && (
          <span className="rpt-node-modegated-chip" title={t('workflowEditor.trigger.modeGatedTip')}>
            {t('workflowEditor.trigger.modeGated')}
          </span>
        )}
        {/* Trigger on/off switch (WP6.4a): a disabled trigger never fires (the agent's off-switch).
            stopPropagation so toggling doesn't also select the node. */}
        {isTrigger && (
          <button
            type="button"
            className={`rpt-node-trigger-switch${disabled ? '' : ' on'}`}
            role="switch"
            aria-checked={!disabled}
            aria-label={t('workflowEditor.enabled')}
            title={t('workflowEditor.enabled')}
            onClick={(e) => {
              e.stopPropagation()
              setNodeDisabled(editorNode.id, !disabled)
            }}
          >
            <span className="rpt-node-trigger-switch-knob" aria-hidden />
          </button>
        )}
        {/* RF-01: manual "run now" ▶. Enabled only when the open doc is the chat's active doc, the
            draft is saved, and the node isn't disabled. stopPropagation so firing doesn't also select. */}
        {manualRun && (
          <button
            type="button"
            className="rpt-node-run-now"
            disabled={!manualRun.enabled || running}
            title={
              manualRun.disabledReason === 'saveFirst'
                ? t('workflowEditor.runNowSaveFirst')
                : manualRun.disabledReason === 'inactiveDoc'
                  ? t('workflowEditor.runNowInactiveDoc')
                  : t('workflowEditor.runNow')
            }
            aria-label={t('workflowEditor.runNow')}
            onClick={(e) => {
              e.stopPropagation()
              setRunning(true)
              void manualRun.run().finally(() => setRunning(false))
            }}
          >
            ▶
          </button>
        )}
        {trace && (
          <span
            className={`rpt-node-trace-chip is-${trace.status}${trace.failedOpen ? ' is-failed-open' : ''}`}
            title={traceTitle}
          >
            <span className="rpt-node-trace-dot" aria-hidden />
            {trace.status === 'failed'
              ? t('workflow.trace.status.failed')
              : trace.failedOpen
                ? t('workflow.trace.status.failedOpen')
                : trace.ms !== undefined
                  ? formatTraceSeconds(trace.ms)
                  : t(`workflow.trace.status.${trace.status}`)}
          </span>
        )}
      </div>
      {/* Live trigger caption (WP6.4a): description + "now {current} · at {required}" + a met dot. */}
      {triggerBadge && (
        <div className="rpt-node-trigger-badge" title={triggerBadge.description}>
          <span
            className={`rpt-node-trigger-dot${triggerBadge.met ? ' met' : ''}`}
            aria-hidden
          />
          <span className="rpt-node-trigger-caption">
            {triggerBadge.current !== undefined || triggerBadge.required !== undefined
              ? t('workflowEditor.trigger.nowAt', {
                  now: String(triggerBadge.current ?? '—'),
                  at: String(triggerBadge.required ?? '—')
                })
              : triggerBadge.description}
          </span>
        </div>
      )}
      {/* Normal-flow port rows: each row positions its own Handle (absolute, vertically centered
          on the row) so handles always sit on the card's edge next to their label — the previous
          absolute-offset scheme measured from the wrong origin and pushed rows past the card. */}
      <div className="rpt-node-ports">
        <div className="rpt-node-col rpt-node-col-in">
          {inputs.map((port) => (
            <div className="rpt-node-port-row" key={`in-${port.name}`}>
              <Handle
                type="target"
                position={Position.Left}
                id={port.name}
                className={portTypeClass(port.type)}
              />
              <span className="rpt-node-port-label">{port.name}</span>
            </div>
          ))}
        </div>
        <div className="rpt-node-col rpt-node-col-out">
          {outputs.map((port) => (
            <div className="rpt-node-port-row rpt-node-port-row-out" key={`out-${port.name}`}>
              <span className="rpt-node-port-label">{port.name}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.name}
                className={portTypeClass(port.type)}
              />
            </div>
          ))}
        </div>
      </div>
      {/* WP-D: prompt excerpt (2 lines) on an ungrouped prompt-bearing node. */}
      {promptText && (
        <div className="rpt-node-excerpt rpt-agent-excerpt-2">{excerptOf(promptText, 160)}</div>
      )}
    </div>
  )
}

/** Everything the AGENT card/frame renders for one trigger-rooted group (agent-memory-ux WP-D;
 *  spec §1/§4). Derived in FlowCanvasInner (one memo over doc + badges + runs + errors) and passed
 *  through node data; absent for non-agent groups, which keep the plain module card. */
interface AgentCardData extends Record<string, unknown> {
  state: AgentEnabledState
  sentence: AgentSentence
  /** Owner manual-pass fix: the switch is on but EVERY trigger is dead-ended by the current
   *  control.mode selection — the card dims like off (the sentence says "Gated by mode · …"). */
  allModeGated: boolean
  /** trace.startedAt + outcome of the newest attributed run (fail-soft: old records don't attribute). */
  lastRunAt: number | null
  lastRunOk: boolean | null
  /** One-line prompt excerpt from the first prompt-bearing member (via WP-A promptFields). */
  excerpt: string | null
  /** A member node has a validation error (doc errors filtered by membership). */
  invalid: boolean
}

/** Render an AgentSentence (i18n key + params — agentModel emits keys, never concatenated text). */
function AgentSentenceText({ sentence }: { sentence: AgentSentence }): React.JSX.Element {
  const t = useT()
  return (
    <>
      {t(sentence.key, {
        desc: sentence.desc,
        ago: sentence.ago ? t(sentence.ago.key, sentence.ago.params) : ''
      })}
    </>
  )
}

/** The agent on/off switch shared by the collapsed card and the expanded frame header: proxies ALL
 *  member triggers' disabled flags (mixed renders off + an indicator dot; toggling writes all). */
function AgentSwitch({ groupId, state }: { groupId: string; state: AgentEnabledState }): React.JSX.Element {
  const t = useT()
  const setGroupTriggersDisabled = useWorkflowEditorStore((s) => s.setGroupTriggersDisabled)
  const on = state === 'on'
  return (
    <button
      type="button"
      className={`rpt-node-trigger-switch${on ? ' on' : ''}${state === 'mixed' ? ' rpt-agent-switch-mixed' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={t('workflowEditor.enabled')}
      title={state === 'mixed' ? t('workflowEditor.agent.mixedTitle') : t('workflowEditor.enabled')}
      onClick={(e) => {
        e.stopPropagation()
        // Mixed resolves to ON (enable everything); on→off, off→on.
        setGroupTriggersDisabled(groupId, state === 'on')
      }}
    >
      <span className="rpt-node-trigger-switch-knob" aria-hidden />
      {state === 'mixed' && <span className="rpt-agent-mixed-dot" aria-hidden />}
    </button>
  )
}

/** Collapsed-module node data (one-canvas rebuild WP6.3; WP-D adds the optional agent payload). */
interface RptModuleData extends Record<string, unknown> {
  group: GroupDecl
  memberCount: number
  agent?: AgentCardData
}

function RptModuleNode({ data, selected }: NodeProps<RFNode<RptModuleData>>): React.JSX.Element {
  const t = useT()
  const toggleGroupCollapsed = useWorkflowEditorStore((s) => s.toggleGroupCollapsed)
  const { group, memberCount, agent } = data
  const exposedCount = group.exposed?.length ?? 0
  return (
    <div
      className={`rpt-module${agent ? ' rpt-agent-card' : ''}${agent?.state === 'off' || agent?.allModeGated ? ' rpt-agent-off' : ''}${selected ? ' selected' : ''}`}
    >
      {/* One generic target handle (left) + one source handle (right); both share the 'module' id. */}
      <Handle type="target" position={Position.Left} id={MODULE_PORT} className="rpt-port-any" />
      <div className="rpt-module-title-row">
        <span className="rpt-module-name">{group.name}</span>
        {/* WP-D: the agent's on/off switch (proxy over ALL member triggers). */}
        {agent && <AgentSwitch groupId={group.id} state={agent.state} />}
        <button
          type="button"
          className="rpt-module-expand"
          title={t('workflowEditor.module.expand')}
          onClick={(e) => {
            e.stopPropagation()
            toggleGroupCollapsed(group.id)
          }}
        >
          {t('workflowEditor.module.expand')}
        </button>
      </div>
      {/* WP-D: the status sentence — the agent reports in prose (spec design principle). */}
      {agent && (
        <div className="rpt-agent-sentence">
          {agent.lastRunAt != null && (
            <span
              className={`rpt-agent-run-dot${agent.lastRunOk === false ? ' failed' : ''}`}
              aria-hidden
            />
          )}
          <AgentSentenceText sentence={agent.sentence} />
        </div>
      )}
      <div className="rpt-module-meta">
        <span>{t('workflowEditor.module.members', { n: memberCount })}</span>
        {exposedCount > 0 && <span>· {exposedCount}</span>}
        {/* WP-D: validation dot — a member node is invalid. */}
        {agent?.invalid && (
          <span className="rpt-agent-invalid-dot" title={t('workflowEditor.agent.invalid')} />
        )}
      </div>
      {/* WP-D: one-line prompt excerpt (first system row of the first prompt-bearing member). */}
      {agent?.excerpt && <div className="rpt-agent-excerpt rpt-agent-excerpt-1">{agent.excerpt}</div>}
      <Handle type="source" position={Position.Right} id={MODULE_PORT} className="rpt-port-any" />
    </div>
  )
}

/** Expanded group frame data (one-canvas rebuild WP6.3; WP-D adds the optional agent payload). */
interface RptGroupFrameData extends Record<string, unknown> {
  group: GroupDecl
  agent?: AgentCardData
}

function RptGroupFrameNode({ data }: NodeProps<RFNode<RptGroupFrameData>>): React.JSX.Element {
  const t = useT()
  const toggleGroupCollapsed = useWorkflowEditorStore((s) => s.toggleGroupCollapsed)
  const selectGroup = useWorkflowEditorStore((s) => s.selectGroup)
  const renameGroup = useWorkflowEditorStore((s) => s.renameGroup)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const { group, agent } = data
  // WP-D: inline rename on double-click (frame header). Local draft; commit on Enter/blur, cancel Esc.
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(group.name)
  const commit = (): void => {
    setEditing(false)
    const name = draft.trim()
    if (name && name !== group.name) renameGroup(group.id, name)
  }
  return (
    <div className="rpt-group-frame">
      {/* Only the header receives pointer events (the frame body is pass-through, so the member
          nodes on top of it stay interactive). */}
      <div className="rpt-group-frame-header">
        {editing ? (
          <input
            className="rpt-group-frame-rename"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(false)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="rpt-group-frame-name"
            title={readOnly ? undefined : t('workflowEditor.agent.renameTitle')}
            onClick={(e) => {
              e.stopPropagation()
              selectGroup(group.id)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (readOnly) return
              setDraft(group.name)
              setEditing(true)
            }}
          >
            {group.name}
          </span>
        )}
        {/* WP-D: same switch + sentence as the collapsed card, in the expanded header. */}
        {agent && <AgentSwitch groupId={group.id} state={agent.state} />}
        {agent && (
          <span className="rpt-agent-sentence rpt-agent-sentence-frame">
            <AgentSentenceText sentence={agent.sentence} />
          </span>
        )}
        <button
          type="button"
          className="rpt-group-frame-collapse"
          title={t('workflowEditor.module.collapse')}
          onClick={(e) => {
            e.stopPropagation()
            toggleGroupCollapsed(group.id)
          }}
        >
          {t('workflowEditor.module.collapse')}
        </button>
      </div>
    </div>
  )
}

const nodeTypes: NodeTypes = {
  rpt: RptNode,
  rptModule: RptModuleNode,
  rptGroupFrame: RptGroupFrameNode
}

interface FlowCanvasProps {
  profileId: string
  /** WP6.4a: when set, REPLACES the live last-run overlay — replay a chosen run's trace onto the
   *  canvas. Node ids map directly; the workflowId gate is skipped (ids absent from the open doc just
   *  don't paint). Null → the live overlay behaviour. */
  traceOverride?: WorkflowRunTrace | null
  /** WP6.4a: bumped by the parent after a save so the live trigger badges refetch. */
  triggerRefreshToken?: number
  /** RF-01: fired after a manual trigger run completes, so the parent can bump its shared refresh
   *  token (refetches the RunDrawer + the trigger badges). */
  onManualRun?: () => void
  /** RF-04: exposes a canvas API to the parent (which sits outside the ReactFlow context). Called once
   *  on mount; `centerPosition` maps the canvas wrapper's bounding-rect center through
   *  screenToFlowPosition, so the parent can insert modules/nodes at the viewport center. */
  onReady?: (api: { centerPosition: () => { x: number; y: number } }) => void
}

function FlowCanvasInner({
  profileId,
  traceOverride,
  triggerRefreshToken,
  onManualRun,
  onReady
}: FlowCanvasProps): React.JSX.Element {
  const t = useT()
  const pushToast = useToastStore((s) => s.push)
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const edges = useWorkflowEditorStore((s) => s.edges)
  const nodeTypeList = useWorkflowEditorStore((s) => s.nodeTypes)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const selectedNodeId = useWorkflowEditorStore((s) => s.selectedNodeId)
  const selectedGroupId = useWorkflowEditorStore((s) => s.selectedGroupId)
  const doc = useWorkflowEditorStore((s) => s.doc)
  const moveNode = useWorkflowEditorStore((s) => s.moveNode)
  const removeNode = useWorkflowEditorStore((s) => s.removeNode)
  const removeEdge = useWorkflowEditorStore((s) => s.removeEdge)
  const connect = useWorkflowEditorStore((s) => s.connect)
  const select = useWorkflowEditorStore((s) => s.select)
  const addNode = useWorkflowEditorStore((s) => s.addNode)
  const dirty = useWorkflowEditorStore((s) => s.dirty)
  const groups = useMemo(() => doc?.groups ?? [], [doc])
  const setSelectedNodeIds = useWorkflowEditorStore((s) => s.setSelectedNodeIds)
  const selectGroup = useWorkflowEditorStore((s) => s.selectGroup)
  const moveGroup = useWorkflowEditorStore((s) => s.moveGroup)
  const snapshotForDrag = useWorkflowEditorStore((s) => s.snapshotForDrag)
  const endDrag = useWorkflowEditorStore((s) => s.endDrag)
  const collapseChainIntoModule = useWorkflowEditorStore((s) => s.collapseChainIntoModule)
  // RF-03: ids (nodes AND modules) currently mid-drag. A rising edge (id enters the set) pushes
  // ONE undo checkpoint before the drag's first move; when the set drains, endDrag() closes the
  // step so the next drag is a separate undo entry.
  const draggingIds = React.useRef<Set<string>>(new Set())
  // Module drag: RF reports absolute positions per change; track each module's last position so a
  // drag becomes a delta routed to moveGroup (which shifts the hidden members). Keyed by group id.
  const moduleDragPos = React.useRef<Map<string, { x: number; y: number }>>(new Map())

  const { screenToFlowPosition, setCenter } = useReactFlow()

  // WP-F (spec §5): the Agents ▾ locate button bumps `panRequest`; pan/zoom to the group's bounds.
  const panRequest = useWorkflowEditorStore((s) => s.panRequest)
  React.useEffect(() => {
    if (!panRequest) return
    const group = groups.find((g) => g.id === panRequest.groupId)
    if (!group) return
    const b = groupBounds(nodes, new Set(group.nodeIds))
    void setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: 1, duration: 400 })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on each locate (token bump), not on graph edits
  }, [panRequest?.token])

  // RF-04: the canvas wrapper, so centerPosition() can map its bounding-rect center to flow coords
  // for the parent (which lives outside the ReactFlow context and can't call screenToFlowPosition).
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    onReady?.({
      centerPosition: () => {
        const rect = wrapperRef.current?.getBoundingClientRect()
        if (!rect) return { x: 220, y: 200 }
        return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register once on mount; screenToFlowPosition/onReady are stable enough for a one-shot handle
  }, [])

  const typeInfoMap = useMemo(() => {
    return new Map(nodeTypeList.map((t) => [t.type, t]))
  }, [nodeTypeList])

  // Last-run trace overlay (spec §13): shown only when the active chat's latest run executed THE
  // WORKFLOW OPEN IN THE EDITOR — a trace from a different doc would paint misleading statuses.
  const currentId = useWorkflowEditorStore((s) => s.currentId)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const lastTrace = useWorkflowTraceStore((s) =>
    activeChatId ? s.traces[activeChatId] : undefined
  )
  const traceByNode = useMemo(() => {
    // WP6.4a: a replay override REPLACES the live overlay + skips the workflowId gate (node ids map
    // directly; ids absent from the open doc simply don't paint).
    if (traceOverride) return new Map(traceOverride.nodes.map((n) => [n.nodeId, n]))
    if (!lastTrace || !currentId || lastTrace.workflowId !== currentId)
      return new Map<string, TraceNode>()
    return new Map(lastTrace.nodes.map((n) => [n.nodeId, n]))
  }, [traceOverride, lastTrace, currentId])

  // Live trigger badges (WP6.4a): fetch explainDocTriggers once per (open doc, activeChatId) when the
  // OPEN doc IS the chat's resolved active doc — reusing the trace-overlay gating idiom (a trigger's
  // "now/at" only makes sense against the chat whose committed state it evaluates). Refetch on save
  // (triggerRefreshToken). NO polling.
  const [triggerBadges, setTriggerBadges] = React.useState<Map<string, DocTriggerBadge>>(new Map())
  // RF-01: whether the OPEN doc IS the chat's resolved active doc — the gate the manual ▶ needs
  // (runManualDoc no-ops otherwise). Tracked alongside the badge fetch (same gate), never polled.
  const [docIsActive, setDocIsActive] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    setTriggerBadges(new Map())
    setDocIsActive(false)
    if (!activeChatId || !currentId) return
    void (async () => {
      // Only badge when the OPEN doc is the chat's resolved active doc (the same gate the trace overlay
      // uses: a badge against a different doc's state would mislead).
      const resolvedId = await window.api.resolveWorkflowId(profileId, activeChatId)
      if (cancelled || resolvedId !== currentId) return
      setDocIsActive(true)
      const list = (await window.api.explainDocTriggers(profileId, activeChatId)) as {
        nodeId: string
        description: string
        met: boolean
        current?: number | string | boolean
        required?: number | string | boolean
      }[]
      if (cancelled) return
      setTriggerBadges(
        new Map(
          (list ?? []).map((e) => [
            e.nodeId,
            { met: e.met, current: e.current, required: e.required, description: e.description }
          ])
        )
      )
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on doc/chat/save; profileId stable
  }, [activeChatId, currentId, triggerRefreshToken])

  // RF-01: fire ONE trigger.manual node's chain. Guards (active doc, node kind, disabled) live in
  // runManualDoc main-side; here we only avoid the call when we have nothing to key it to. On success
  // toast + bump the parent's shared refresh token (RunDrawer + badges refetch).
  const runManual = useCallback(
    async (nodeId: string): Promise<void> => {
      if (!activeChatId || !currentId) return
      await window.api.runManualTrigger(profileId, activeChatId, currentId, nodeId)
      pushToast(t('workflowEditor.runNowDone'))
      onManualRun?.()
    },
    [profileId, activeChatId, currentId, onManualRun, pushToast, t]
  )

  // Run history (WP-D run attribution): the active chat's recent runs, so an agent card can show its
  // last-run recency (newestRunForGroup maps StoredRunRecord.triggerNodeIds through membership).
  // Refetched on chat switch + after a save (triggerRefreshToken) — same cadence as the trigger badges.
  const [runRecords, setRunRecords] = React.useState<StoredRunRecord[]>([])
  React.useEffect(() => {
    let cancelled = false
    if (!activeChatId) {
      setRunRecords([])
      return
    }
    void (async () => {
      const page = (await window.api.listAgentPackRuns(profileId, activeChatId)) as StoredRunRecord[]
      if (!cancelled) setRunRecords(page ?? [])
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on chat switch + save; profileId stable
  }, [activeChatId, triggerRefreshToken])

  const errors = useWorkflowEditorStore((s) => s.errors)

  // Owner manual-pass fix: the triggers a control.mode selection currently dead-ends (doc-wide,
  // display-only derivation — never writes trigger.disabled). Flipping the mode dropdown updates
  // `nodes` (setNodeConfig on the mode node), so everything below re-derives immediately.
  const modeGatedIds = useMemo(
    () => modeGatedTriggerIds(nodes, edges, typeInfoMap),
    [nodes, edges, typeInfoMap]
  )

  // WP-D (spec §1/§4): everything each AGENT group's card/frame renders, derived once over the doc +
  // catalog + live badges + run history + validation. Non-agent groups get no entry (plain module card).
  const agentByGroupId = useMemo(() => {
    const now = Date.now()
    const errorNodeIds = new Set(errors.map((e) => e.nodeId).filter((id): id is string => !!id))
    const map = new Map<string, AgentCardData>()
    for (const g of groups) {
      if (!isAgentGroup(nodes, g, typeInfoMap)) continue
      const state = agentEnabledState(nodes, g, typeInfoMap)
      const triggers = agentTriggers(nodes, g, typeInfoMap)
      const describe = (tn: (typeof triggers)[number]): string =>
        describeTriggerNode(tn, triggerBadges.get(tn.id)?.description)
      // The sentence composes from EFFECTIVE triggers (enabled AND not mode-gated); when the switch
      // is on but the mode gates everything, the mode-gated variant renders ALL descriptions (what
      // the agent WOULD do) — owner fix: mode=off must not read as "runs every N floors".
      const effective = triggers.filter((tn) => tn.disabled !== true && !modeGatedIds.has(tn.id))
      const allModeGated = state === 'on' && triggers.length > 0 && effective.length === 0
      const descriptions = (allModeGated || state !== 'on' ? triggers : effective).map(describe)
      const newest = newestRunForGroup(runRecords, new Set(g.nodeIds))
      map.set(g.id, {
        state,
        sentence: agentStatusSentence({
          descriptions,
          state,
          ...(allModeGated ? { allModeGated: true } : {}),
          ...(newest ? { lastRunAt: newest.trace.startedAt } : {}),
          now
        }),
        allModeGated,
        lastRunAt: newest ? newest.trace.startedAt : null,
        lastRunOk: newest ? newest.trace.ok : null,
        excerpt: promptExcerpt(nodes, g, typeInfoMap),
        invalid: g.nodeIds.some((id) => errorNodeIds.has(id))
      })
    }
    return map
  }, [groups, nodes, edges, typeInfoMap, triggerBadges, runRecords, errors, modeGatedIds])

  // On-canvas modules (WP6.3): project the doc's groups onto the canvas — collapsed groups hide
  // their members behind one module node, expanded groups render a background frame; boundary edges
  // re-point to synthetic module edges. Ungrouped/expanded members render as normal 'rpt' nodes.
  const view = useMemo(
    () => collapsedView(nodes, edges, groups),
    [nodes, edges, groups]
  )
  // Which node ids are hidden behind a collapsed module (so their real edges don't also render).
  const hiddenNodeIds = useMemo(() => {
    const hidden = new Set<string>()
    for (const g of groups) if (g.collapsed) for (const id of g.nodeIds) hidden.add(id)
    return hidden
  }, [groups])

  const rfNodes: RFNode[] = useMemo(() => {
    const out: RFNode[] = []
    // Expanded group frames first (zIndex -1 so they sit behind their members).
    for (const g of groups) {
      if (g.collapsed) continue
      const b = groupBounds(nodes, new Set(g.nodeIds))
      out.push({
        id: `frame:${g.id}`,
        type: 'rptGroupFrame',
        position: { x: b.x, y: b.y },
        width: b.w,
        height: b.h,
        selectable: false,
        draggable: false,
        deletable: false,
        connectable: false,
        zIndex: -1,
        data: { group: g, agent: agentByGroupId.get(g.id) }
      } as RFNode)
    }
    // Collapsed module nodes.
    for (const m of view.moduleNodes) {
      out.push({
        id: m.group.id,
        type: 'rptModule',
        position: m.position,
        selected: m.group.id === selectedGroupId,
        draggable: !readOnly,
        deletable: !readOnly,
        connectable: false,
        data: { group: m.group, memberCount: m.memberCount, agent: agentByGroupId.get(m.group.id) }
      } as RFNode)
    }
    // Visible normal nodes.
    for (const n of view.visibleNodes) {
      out.push({
        id: n.id,
        type: 'rpt',
        position: n.position,
        selected: n.id === selectedNodeId,
        draggable: !readOnly,
        connectable: !readOnly,
        deletable: !readOnly,
        data: {
          editorNode: n,
          typeInfo: typeInfoMap.get(n.type),
          trace: traceByNode.get(n.id),
          triggerBadge: triggerBadges.get(n.id),
          // Owner manual-pass fix: dim + chip a trigger the current mode selection dead-ends.
          modeGated: modeGatedIds.has(n.id),
          // RF-01: only manual triggers get a ▶. enabled folds in the active-doc gate, the dirty flag,
          // and the node's own disabled state; the reason CODE drives the tooltip (translated in RptNode).
          ...(n.type === 'trigger.manual'
            ? {
                manualRun: {
                  enabled: docIsActive && !dirty && n.disabled !== true,
                  disabledReason: dirty
                    ? ('saveFirst' as const)
                    : !docIsActive
                      ? ('inactiveDoc' as const)
                      : null,
                  run: () => runManual(n.id)
                }
              }
            : {})
        }
      } as RFNode)
    }
    return out
  }, [
    nodes,
    groups,
    view,
    selectedNodeId,
    selectedGroupId,
    readOnly,
    typeInfoMap,
    traceByNode,
    triggerBadges,
    docIsActive,
    dirty,
    runManual,
    agentByGroupId,
    modeGatedIds
  ])

  const rfEdges: RFEdge[] = useMemo(() => {
    const out: RFEdge[] = []
    for (const e of edges) {
      // Skip an edge whose either end is hidden behind a collapsed module — the synthetic edge
      // below carries it instead.
      if (hiddenNodeIds.has(e.source) || hiddenNodeIds.has(e.target)) continue
      out.push({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
        deletable: !readOnly,
        selected: false
      })
    }
    for (const s of view.syntheticEdges) {
      out.push({
        id: s.id,
        source: s.source,
        sourceHandle: s.sourcePort,
        target: s.target,
        targetHandle: s.targetPort,
        deletable: false,
        selected: false,
        className: 'rpt-group-edge'
      })
    }
    return out
  }, [edges, view, hiddenNodeIds, readOnly])

  const moduleIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups])

  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          // RF-03: rising-edge undo checkpoint. On the first tick of a drag (dragging === true and
          // this id not yet tracked) snapshot ONCE; when a drag ends (dragging false/undefined)
          // untrack the id and, once nothing is dragging, close the undo step. Frame ids never drag.
          if (!change.id.startsWith('frame:')) {
            if (change.dragging === true) {
              if (!draggingIds.current.has(change.id)) {
                draggingIds.current.add(change.id)
                snapshotForDrag()
              }
            } else if (draggingIds.current.delete(change.id) && draggingIds.current.size === 0) {
              endDrag()
            }
          }
          // A collapsed MODULE drag: RF reports the module node's absolute position; convert to a
          // delta against its last-seen position and route to moveGroup (which shifts the hidden
          // members). Track the position so the next mid-drag change computes the next delta.
          if (moduleIds.has(change.id)) {
            const prev = moduleDragPos.current.get(change.id)
            if (prev) {
              const dx = change.position.x - prev.x
              const dy = change.position.y - prev.y
              if (dx !== 0 || dy !== 0) moveGroup(change.id, { dx, dy })
            }
            moduleDragPos.current.set(change.id, { x: change.position.x, y: change.position.y })
            continue
          }
          // Frame nodes are not draggable; ignore any stray position change for them.
          if (change.id.startsWith('frame:')) continue
          // Apply position on EVERY change (not just drag-end): the store is the single source of
          // truth for RF's controlled nodes, so skipping mid-drag updates froze the node under the
          // cursor and teleported it on release.
          moveNode(change.id, change.position)
        } else if (change.type === 'remove') {
          // deleteKeyCode guard (WP6.3): a selected module/frame must NOT delete its member nodes.
          // Drop RF remove changes for module/frame ids entirely (ungroup is the only removal path).
          if (moduleIds.has(change.id) || change.id.startsWith('frame:')) continue
          removeNode(change.id)
        } else if (change.type === 'select' && !change.selected) {
          // A module deselect clears the module drag baseline so the next drag starts fresh.
          moduleDragPos.current.delete(change.id)
        }
      }
    },
    [moveNode, removeNode, moveGroup, moduleIds, snapshotForDrag, endDrag]
  )

  // Multi-select sync (WP6.3): RF reports the selected NODE set (excludes modules/frames) via
  // onSelectionChange; mirror it into the store so the toolbar's "Group into module" can appear.
  const handleSelectionChange = useCallback(
    ({ nodes: selNodes }: { nodes: RFNode[] }) => {
      const ids = selNodes
        .filter((n) => n.type === 'rpt')
        .map((n) => n.id)
      // Only drive multi-select when ≥2 nodes are selected (a single click is handled by onNodeClick,
      // which also clears group selection); a 0/1 selection here would fight that path.
      if (ids.length >= 2) setSelectedNodeIds(ids)
    },
    [setSelectedNodeIds]
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove') {
          removeEdge(change.id)
        }
      }
    },
    [removeEdge]
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.sourceHandle || !connection.targetHandle) return
      connect(
        { node: connection.source, port: connection.sourceHandle },
        { node: connection.target, port: connection.targetHandle }
      )
    },
    [connect]
  )

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: RFNode) => {
      setChainMenu(null)
      // A collapsed module → select the group (its panel). Frames handle their own header click.
      if (moduleIds.has(node.id)) {
        selectGroup(node.id)
        return
      }
      if (node.id.startsWith('frame:')) return
      select(node.id)
    },
    [select, selectGroup, moduleIds]
  )

  // WP-D one-click grouping (spec §4): right-click a trigger node → "Collapse chain into module".
  // Only offered on an ungrouped trigger node (the store's collapseChainIntoModule re-checks + no-ops
  // otherwise). Positioned at the cursor; dismissed on any pane click / action.
  const [chainMenu, setChainMenu] = React.useState<{ x: number; y: number; triggerId: string } | null>(
    null
  )
  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: RFNode) => {
      if (readOnly || node.type !== 'rpt') return
      const editorNode = (node.data as RptNodeData).editorNode
      if (!isTriggerType(editorNode.type, typeInfoMap)) return
      if (groups.some((g) => g.nodeIds.includes(editorNode.id))) return
      event.preventDefault()
      setChainMenu({ x: event.clientX, y: event.clientY, triggerId: editorNode.id })
    },
    [readOnly, typeInfoMap, groups]
  )

  const handlePaneClick = useCallback(() => {
    select(null)
    setChainMenu(null)
  }, [select])

  const handleDragOver = useCallback(
    (event: React.DragEvent) => {
      if (readOnly) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    },
    [readOnly]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      if (readOnly) return
      event.preventDefault()
      const type = event.dataTransfer.getData(DRAG_MIME)
      if (!type) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const subgraphId = event.dataTransfer.getData(DRAG_SUBGRAPH_ID_MIME)
      if (subgraphId) addNode(type, position, { workflow_id: subgraphId })
      else addNode(type, position)
    },
    [readOnly, screenToFlowPosition, addNode]
  )

  return (
    <div
      className="rpt-workflow-editor"
      ref={wrapperRef}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onSelectionChange={handleSelectionChange}
        onPaneClick={handlePaneClick}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={true}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        fitView
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="rpt-wfe-minimap" />
      </ReactFlow>
      {chainMenu && (
        <div
          className="rpt-canvas-context-menu"
          style={{ left: chainMenu.x, top: chainMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="rpt-canvas-context-item"
            onClick={() => {
              collapseChainIntoModule(chainMenu.triggerId)
              setChainMenu(null)
            }}
          >
            {t('workflowEditor.agent.collapseChain')}
          </button>
        </div>
      )}
    </div>
  )
}

export default function FlowCanvas(props: FlowCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
