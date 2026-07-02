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
import { useOptionalT, useT } from '../../i18n'
import type { EditorNode } from './editorModel'

/** Matches the palette drag payload's mime type (drag source lives in a later task's palette
 *  component; this is the contract both sides must agree on). */
const DRAG_MIME = 'application/rpt-node-type'

interface RptNodeData extends Record<string, unknown> {
  editorNode: EditorNode
  typeInfo: NodeTypeInfo | undefined
}

/** Maps a PortType to the CSS class workflowEditor.css keys its color off. Falls back to `Any`'s
 *  (neutral) styling for unknown/legacy port type strings so a catalog drift can't crash render. */
function portTypeClass(type: string | undefined): string {
  switch (type) {
    case 'Messages':
    case 'Text':
    case 'Vars':
    case 'Context':
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
  const { editorNode, typeInfo } = data
  const inputs = typeInfo?.inputs ?? []
  const outputs = typeInfo?.outputs ?? []
  // Localized node title with the catalog's English title as the fallback.
  const title =
    tOpt(`workflowEditor.nodeTitle.${editorNode.type}`) || typeInfo?.title || editorNode.type

  return (
    <div
      className={`rpt-node${selected ? ' selected' : ''}${editorNode.isMainOutput ? ' is-main-output' : ''}`}
    >
      <div className="rpt-node-title-row">
        {editorNode.isMainOutput && (
          <span className="rpt-node-main-badge" title={t('workflowEditor.mainOutput')}>
            ★
          </span>
        )}
        <span className="rpt-node-title">{title}</span>
        <span className="rpt-node-type-id">{editorNode.type}</span>
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
        data: { editorNode: n, typeInfo: typeInfoMap.get(n.type) }
      })),
    [nodes, selectedNodeId, readOnly, typeInfoMap]
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
      addNode(type, position)
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
