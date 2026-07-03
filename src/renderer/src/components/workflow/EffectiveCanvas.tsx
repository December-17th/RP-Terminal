// Read-mostly React Flow canvas for the Workflow view's EFFECTIVE mode (agent-packs plan WP3.6a;
// ADR 0010). Renders the LIVE projection (narrator + gate-open packs) with pack nodes VISUALLY GROUPED
// into labeled regions, dashed splice edges (where packs plug into the narrator), a per-region gate
// chip (toggleable → live recompose), and detached placeholder regions for trigger-only packs.
//
// This is ADDITIVE to Normal mode: it reads useEffectiveGraphStore (never useWorkflowEditorStore's
// draft), renders its own node type, and does not save the composed doc (ADR 0001). Narrator nodes are
// selectable + write-through-editable via the parent view; pack nodes are LOCKED this stage (WP3.6b
// routes their edits through a fork) — selecting one shows read-only config with a "fork to edit"
// affordance in the config panel, and no edit path here mutates a pack node.
import React, { useCallback, useMemo } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeProps,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './workflowEditor.css'
import './effectiveMode.css'
import { useEffectiveGraphStore } from '../../stores/effectiveGraphStore'
import { useWorkflowEditorStore, type NodeTypeInfo } from '../../stores/workflowEditorStore'
import { useOptionalT, useT } from '../../i18n'
import {
  buildPackRegions,
  isSpliceEdge,
  nodeOwnerMap,
  ownerOfNodeId,
  projectionNodePositions,
  readComposition
} from './effectiveProjection'
import type { EditorNode } from './editorModel'

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

interface EffNodeData extends Record<string, unknown> {
  editorNode: EditorNode
  typeInfo: NodeTypeInfo | undefined
  owner: 'narrator' | 'pack'
}

/** A projection node — the SAME visual as the editor's RptNode, tinted by owner. Pack nodes carry a
 *  small lock affordance (they are locked this stage). Read-only: no main-output star editing here. */
function EffNode({ data, selected }: NodeProps<RFNode<EffNodeData>>): React.JSX.Element {
  const t = useT()
  const tOpt = useOptionalT()
  const { editorNode, typeInfo, owner } = data
  const inputs = typeInfo?.inputs ?? []
  const outputs = typeInfo?.outputs ?? []
  const title =
    tOpt(`workflowEditor.nodeTitle.${editorNode.type}`) || typeInfo?.title || editorNode.type

  return (
    <div className={`rpt-node rpt-eff-node ${owner}${selected ? ' selected' : ''}`}>
      <div className="rpt-node-title-row">
        {owner === 'pack' && (
          <span className="rpt-eff-lock" title={t('workflowEffective.packLocked')} aria-hidden>
            🔒
          </span>
        )}
        <span className="rpt-node-title">{title}</span>
        <span className="rpt-node-type-id">{editorNode.type}</span>
      </div>
      <div className="rpt-node-ports">
        <div className="rpt-node-col rpt-node-col-in">
          {inputs.map((port) => (
            <div className="rpt-node-port-row" key={`in-${port.name}`}>
              <Handle
                type="target"
                position={Position.Left}
                id={port.name}
                className={portTypeClass(port.type)}
                isConnectable={false}
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
                isConnectable={false}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

interface RegionData extends Record<string, unknown> {
  packName: string
  gateOpen: boolean
  detached: boolean
  onToggleGate: (open: boolean) => void
  triggerCaption?: string
  /** Fork provenance (ADR 0006; WP3.6b Part C) — present on forked regions so the header localizes
   *  "fork" and shows a subtle "from <base>" lineage line. */
  fork?: { base: string; n: number }
}

/** A pack REGION frame: a tinted hull with a header band carrying the pack name + a toggleable gate
 *  chip. React Flow renders it as a non-selectable group node BEHIND its member nodes (zIndex -1). A
 *  detached region (trigger-only pack) shows a placeholder card + trigger caption instead of members. */
function RegionNode({ data }: NodeProps<RFNode<RegionData>>): React.JSX.Element {
  const t = useT()
  const { packName, gateOpen, detached, onToggleGate, triggerCaption, fork } = data
  // Forked region: localize the "fork" word from the structured marker (name in the store is the
  // neutral fallback; here we prefer the localized form) + a subtle "from <base>" lineage line.
  const displayName = fork ? `${fork.base} (${t('workflowEffective.fork')} ${fork.n})` : packName
  return (
    <div className={`rpt-eff-region${detached ? ' detached' : ''}${fork ? ' forked' : ''}`}>
      <div className="rpt-eff-region-header">
        <span className="rpt-eff-region-name">
          {displayName}
          {fork && (
            <span className="rpt-eff-region-lineage" title={t('workflowEffective.forkLineageTitle')}>
              {t('workflowEffective.forkFrom', { base: fork.base })}
            </span>
          )}
        </span>
        <button
          role="switch"
          aria-checked={gateOpen}
          className={`rpt-eff-gate${gateOpen ? ' on' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggleGate(!gateOpen)
          }}
          title={t(gateOpen ? 'workflowEffective.gateOn' : 'workflowEffective.gateOff')}
        >
          <span className="rpt-eff-gate-knob" aria-hidden />
          <span className="rpt-eff-gate-label">
            {t(gateOpen ? 'workflowEffective.gateOn' : 'workflowEffective.gateOff')}
          </span>
        </button>
      </div>
      {detached && (
        <div className="rpt-eff-detached-body">
          <div className="rpt-eff-detached-title">{t('workflowEffective.triggerOnly')}</div>
          <div className="rpt-eff-detached-desc">{t('workflowEffective.triggerOnlyDesc')}</div>
          {triggerCaption && <div className="rpt-eff-detached-caption">{triggerCaption}</div>}
        </div>
      )}
    </div>
  )
}

const nodeTypes: NodeTypes = { eff: EffNode, effRegion: RegionNode }

interface EffectiveCanvasProps {
  profileId: string
  /** Trigger captions per pack id (describeTrigger of the pack's trigger attachments), for detached
   *  regions. Supplied by the parent, which has the pack summaries. */
  triggerCaptions: Record<string, string>
}

function EffectiveCanvasInner({
  profileId,
  triggerCaptions
}: EffectiveCanvasProps): React.JSX.Element {
  const t = useT()
  const doc = useEffectiveGraphStore((s) => s.doc)
  const packs = useEffectiveGraphStore((s) => s.packs)
  const toggleGate = useEffectiveGraphStore((s) => s.toggleGate)
  const nodeTypeList = useWorkflowEditorStore((s) => s.nodeTypes)
  const selectedNodeId = useWorkflowEditorStore((s) => s.selectedNodeId)
  const select = useWorkflowEditorStore((s) => s.select)

  const typeInfoMap = useMemo(
    () => new Map(nodeTypeList.map((nt) => [nt.type, nt])),
    [nodeTypeList]
  )

  // Projection layout: regions stacked below the narrator; pack node positions overridden with the
  // programmatic ones; splice edges (narrator↔pack) marked dashed.
  const composition = useMemo(() => (doc ? readComposition(doc) : undefined), [doc])
  const owners = useMemo(() => nodeOwnerMap(composition), [composition])
  const placements = useMemo(
    () => packs.map((p) => ({ packId: p.packId, triggerOnly: p.triggerOnly })),
    [packs]
  )
  const regions = useMemo(
    () => buildPackRegions(composition, placements),
    [composition, placements]
  )
  const posOverride = useMemo(() => projectionNodePositions(regions), [regions])
  const packById = useMemo(() => new Map(packs.map((p) => [p.packId, p])), [packs])
  // A triggerOnly pack's nodes are present-but-detached (no splice edges) — they are REPRESENTED by
  // the detached placeholder region, so we hide their raw nodes from the canvas (they'd otherwise
  // float at their fragment-space coords). The set of pack ids to hide nodes for:
  const detachedPackIds = useMemo(
    () => new Set(packs.filter((p) => p.triggerOnly).map((p) => p.packId)),
    [packs]
  )

  const rfNodes: RFNode[] = useMemo(() => {
    if (!doc) return []
    // Region frames first (rendered behind their members via a lower zIndex).
    const regionNodes: RFNode<RegionData>[] = regions.map((r) => {
      const info = packById.get(r.packId)
      return {
        id: `region:${r.packId}`,
        type: 'effRegion',
        position: { x: r.bounds.x, y: r.bounds.y },
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        zIndex: -1,
        style: { width: r.bounds.width, height: r.bounds.height },
        data: {
          packName: info?.name ?? r.packId,
          gateOpen: info?.gateOpen ?? true,
          detached: r.detached,
          triggerCaption: triggerCaptions[r.packId],
          ...(info?.fork ? { fork: info.fork } : {}),
          onToggleGate: (open: boolean) => void toggleGate(profileId, r.packId, open)
        }
      }
    })
    const graphNodes: RFNode<EffNodeData>[] = doc.nodes
      .filter((n) => {
        // Hide nodes belonging to a detached (trigger-only) pack — the placeholder region stands in.
        const parsed = ownerOfNodeId(n.id)
        const packId = owners.get(n.id) ?? (parsed.kind === 'pack' ? parsed.packId : undefined)
        return !(packId && detachedPackIds.has(packId))
      })
      .map((n) => {
      const owner = ownerOfNodeId(n.id).kind === 'pack' || owners.has(n.id) ? 'pack' : 'narrator'
      const position = posOverride.get(n.id) ?? n.position ?? { x: 40, y: 40 }
      return {
        id: n.id,
        type: 'eff',
        position,
        selected: n.id === selectedNodeId,
        draggable: false,
        connectable: false,
        deletable: false,
        data: {
          editorNode: {
            id: n.id,
            type: n.type,
            position,
            ...(n.config !== undefined ? { config: n.config } : {})
          },
          typeInfo: typeInfoMap.get(n.type),
          owner
        }
      }
    })
    return [...regionNodes, ...graphNodes]
  }, [
    doc,
    regions,
    packById,
    posOverride,
    owners,
    detachedPackIds,
    typeInfoMap,
    selectedNodeId,
    triggerCaptions,
    toggleGate,
    profileId
  ])

  const rfEdges: RFEdge[] = useMemo(() => {
    if (!doc) return []
    // Edges touching a detached (trigger-only) pack's hidden nodes are dropped (their nodes are gone).
    const isDetachedNode = (nodeId: string): boolean => {
      const parsed = ownerOfNodeId(nodeId)
      const packId = owners.get(nodeId) ?? (parsed.kind === 'pack' ? parsed.packId : undefined)
      return !!packId && detachedPackIds.has(packId)
    }
    return doc.edges
      .filter((e) => !isDetachedNode(e.from.node) && !isDetachedNode(e.to.node))
      .map((e) => {
      const splice = isSpliceEdge(e, owners)
      return {
        id: `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`,
        source: e.from.node,
        sourceHandle: e.from.port,
        target: e.to.node,
        targetHandle: e.to.port,
        deletable: false,
        selectable: false,
        animated: splice,
        className: splice ? 'rpt-eff-splice-edge' : undefined,
        style: splice ? { strokeDasharray: '6 4' } : undefined
      }
    })
  }, [doc, owners, detachedPackIds])

  const handleNodeClick = useCallback(
    (_e: React.MouseEvent, node: RFNode) => {
      if (node.id.startsWith('region:')) return
      select(node.id)
    },
    [select]
  )
  const handlePaneClick = useCallback(() => select(null), [select])

  if (!doc) {
    return <div className="rpt-eff-empty">{t('workflowEffective.noProjection')}</div>
  }

  return (
    <div className="rpt-workflow-editor">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        fitView
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

export default function EffectiveCanvas(props: EffectiveCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <EffectiveCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
