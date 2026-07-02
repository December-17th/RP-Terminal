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

const nodeTypes: NodeTypes = { rpt: RptNode }

interface FlowCanvasProps {
  profileId: string
}

function FlowCanvasInner({ profileId: _profileId }: FlowCanvasProps): React.JSX.Element {
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const edges = useWorkflowEditorStore((s) => s.edges)
  const nodeTypeList = useWorkflowEditorStore((s) => s.nodeTypes)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const selectedNodeId = useWorkflowEditorStore((s) => s.selectedNodeId)
  const moveNode = useWorkflowEditorStore((s) => s.moveNode)
  const removeNode = useWorkflowEditorStore((s) => s.removeNode)
  const removeEdge = useWorkflowEditorStore((s) => s.removeEdge)
  const connect = useWorkflowEditorStore((s) => s.connect)
  const select = useWorkflowEditorStore((s) => s.select)
  const addNode = useWorkflowEditorStore((s) => s.addNode)

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

  const rfNodes: RFNode<RptNodeData>[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'rpt',
        position: n.position,
        selected: n.id === selectedNodeId,
        draggable: !readOnly,
        connectable: !readOnly,
        deletable: !readOnly,
        data: { editorNode: n, typeInfo: typeInfoMap.get(n.type), trace: traceByNode.get(n.id) }
      })),
    [nodes, selectedNodeId, readOnly, typeInfoMap, traceByNode]
  )

  const rfEdges: RFEdge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
        deletable: !readOnly,
        selected: false
      })),
    [edges, readOnly]
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode<RptNodeData>>[]) => {
      for (const change of changes) {
        // Apply position on EVERY change (not just drag-end): the store is the single source of
        // truth for RF's controlled nodes, so skipping mid-drag updates froze the node under the
        // cursor and teleported it on release.
        if (change.type === 'position' && change.position) {
          moveNode(change.id, change.position)
        } else if (change.type === 'remove') {
          removeNode(change.id)
        }
      }
    },
    [moveNode, removeNode]
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
      select(node.id)
    },
    [select]
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
