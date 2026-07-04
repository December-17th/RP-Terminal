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
import { useOptionalT, useT } from '../../i18n'
import { formatTraceSeconds, type TraceNode } from '../../../../shared/workflow/trace'
import type { EditorNode } from './editorModel'
import type { GroupDecl } from '../../../../shared/workflow/types'
import { collapsedView, groupBounds, MODULE_PORT } from './groupModel'

/** Matches the palette drag payload's mime type (drag source lives in a later task's palette
 *  component; this is the contract both sides must agree on). */
const DRAG_MIME = 'application/rpt-node-type'
/** Second drag payload key, set only when dragging a Sub-graphs palette entry (sub-graph nodes
 *  v1 plan §5): carries the target sub-graph's workflow id, so the dropped `subgraph.call` node
 *  arrives preconfigured with `workflow_id` instead of empty. */
const DRAG_SUBGRAPH_ID_MIME = 'application/rpt-subgraph-id'

interface RptNodeData extends Record<string, unknown> {
  editorNode: EditorNode
  typeInfo: NodeTypeInfo | undefined
  /** This node's outcome in the active chat's LAST run of this workflow (spec §13), if any. */
  trace?: TraceNode
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
  const { editorNode, typeInfo, trace } = data
  const inputs = typeInfo?.inputs ?? []
  const outputs = typeInfo?.outputs ?? []
  // Localized node title with the catalog's English title as the fallback.
  const title =
    tOpt(`workflowEditor.nodeTitle.${editorNode.type}`) || typeInfo?.title || editorNode.type
  const traceTitle = trace
    ? `${t(`workflow.trace.status.${trace.status}`)}${trace.ms !== undefined ? ` · ${formatTraceSeconds(trace.ms)}` : ''}${trace.error ? ` — ${trace.error.message}` : ''}`
    : undefined

  return (
    <div
      className={`rpt-node${selected ? ' selected' : ''}${editorNode.isMainOutput ? ' is-main-output' : ''}${trace ? ` rpt-node-trace-${trace.status}` : ''}`}
    >
      <div className="rpt-node-title-row">
        {editorNode.isMainOutput && (
          <span className="rpt-node-main-badge" title={t('workflowEditor.mainOutput')}>
            ★
          </span>
        )}
        <span className="rpt-node-title">{title}</span>
        <span className="rpt-node-type-id">{editorNode.type}</span>
        {trace && (
          <span className={`rpt-node-trace-chip is-${trace.status}`} title={traceTitle}>
            <span className="rpt-node-trace-dot" aria-hidden />
            {trace.status === 'failed'
              ? t('workflow.trace.status.failed')
              : trace.ms !== undefined
                ? formatTraceSeconds(trace.ms)
                : t(`workflow.trace.status.${trace.status}`)}
          </span>
        )}
      </div>
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
    </div>
  )
}

/** Collapsed-module node data (one-canvas rebuild WP6.3). */
interface RptModuleData extends Record<string, unknown> {
  group: GroupDecl
  memberCount: number
}

function RptModuleNode({ data, selected }: NodeProps<RFNode<RptModuleData>>): React.JSX.Element {
  const t = useT()
  const toggleGroupCollapsed = useWorkflowEditorStore((s) => s.toggleGroupCollapsed)
  const { group, memberCount } = data
  const exposedCount = group.exposed?.length ?? 0
  return (
    <div className={`rpt-module${selected ? ' selected' : ''}`}>
      {/* One generic target handle (left) + one source handle (right); both share the 'module' id. */}
      <Handle type="target" position={Position.Left} id={MODULE_PORT} className="rpt-port-any" />
      <div className="rpt-module-title-row">
        <span className="rpt-module-name">{group.name}</span>
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
      <div className="rpt-module-meta">
        <span>{t('workflowEditor.module.members', { n: memberCount })}</span>
        {exposedCount > 0 && <span>· {exposedCount}</span>}
      </div>
      <Handle type="source" position={Position.Right} id={MODULE_PORT} className="rpt-port-any" />
    </div>
  )
}

/** Expanded group frame data (one-canvas rebuild WP6.3): a background rect + header. */
interface RptGroupFrameData extends Record<string, unknown> {
  group: GroupDecl
}

function RptGroupFrameNode({ data }: NodeProps<RFNode<RptGroupFrameData>>): React.JSX.Element {
  const t = useT()
  const toggleGroupCollapsed = useWorkflowEditorStore((s) => s.toggleGroupCollapsed)
  const selectGroup = useWorkflowEditorStore((s) => s.selectGroup)
  const { group } = data
  return (
    <div className="rpt-group-frame">
      {/* Only the header receives pointer events (the frame body is pass-through, so the member
          nodes on top of it stay interactive). */}
      <div className="rpt-group-frame-header">
        <span
          className="rpt-group-frame-name"
          onClick={(e) => {
            e.stopPropagation()
            selectGroup(group.id)
          }}
        >
          {group.name}
        </span>
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
}

function FlowCanvasInner({ profileId: _profileId }: FlowCanvasProps): React.JSX.Element {
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
  const groups = useMemo(() => doc?.groups ?? [], [doc])
  const setSelectedNodeIds = useWorkflowEditorStore((s) => s.setSelectedNodeIds)
  const selectGroup = useWorkflowEditorStore((s) => s.selectGroup)
  const moveGroup = useWorkflowEditorStore((s) => s.moveGroup)
  // Module drag: RF reports absolute positions per change; track each module's last position so a
  // drag becomes a delta routed to moveGroup (which shifts the hidden members). Keyed by group id.
  const moduleDragPos = React.useRef<Map<string, { x: number; y: number }>>(new Map())

  const { screenToFlowPosition } = useReactFlow()

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
    if (!lastTrace || !currentId || lastTrace.workflowId !== currentId)
      return new Map<string, TraceNode>()
    return new Map(lastTrace.nodes.map((n) => [n.nodeId, n]))
  }, [lastTrace, currentId])

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
        data: { group: g }
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
        data: { group: m.group, memberCount: m.memberCount }
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
        data: { editorNode: n, typeInfo: typeInfoMap.get(n.type), trace: traceByNode.get(n.id) }
      } as RFNode)
    }
    return out
  }, [nodes, groups, view, selectedNodeId, selectedGroupId, readOnly, typeInfoMap, traceByNode])

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
    [moveNode, removeNode, moveGroup, moduleIds]
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

  const handlePaneClick = useCallback(() => {
    select(null)
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
    <div className="rpt-workflow-editor" onDrop={handleDrop} onDragOver={handleDragOver}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={handleNodeClick}
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
      </ReactFlow>
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
