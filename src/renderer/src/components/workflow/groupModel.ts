// Pure module for on-canvas module groupings (one-canvas rebuild WP6.3). Groups are DOC METADATA
// over in-place nodes (types.ts GroupDecl) — nothing moves, no subgraph extraction. This module
// mints group ids, computes the bounding box of a group's members, and projects a collapsed view
// (which nodes disappear, which module nodes appear, and how boundary-crossing edges re-point to
// the module id). NO React / @xyflow/react imports — like editorModel.ts it stays vitest-pure and
// imports only the shared workflow types + the local editor shapes.
import type { GroupDecl } from '../../../../shared/workflow/types'
import type { EditorEdge, EditorNode } from './editorModel'

/** Approximate rendered node extent used to size a group's bounding box (a node card is ~220×90;
 *  the exact size is CSS-driven, but the bounds only need to enclose the members visually). */
export const NODE_W = 220
export const NODE_H = 90
const DEFAULT_PAD = 28

/** Mint the next `group-<n>` id not already used by `groups` (parallels addNode's id minting). */
export function nextGroupId(groups: GroupDecl[]): string {
  const used = new Set(groups.map((g) => g.id))
  let n = 1
  while (used.has(`group-${n}`)) n++
  return `group-${n}`
}

/** Axis-aligned bounding box enclosing every member node (by top-left position + node extent),
 *  padded by `pad`. Members not present in `nodes` are skipped; an empty set yields a zero box. */
export function groupBounds(
  nodes: EditorNode[],
  memberIds: Set<string>,
  pad: number = DEFAULT_PAD
): { x: number; y: number; w: number; h: number } {
  const members = nodes.filter((n) => memberIds.has(n.id))
  if (members.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of members) {
    minX = Math.min(minX, n.position.x)
    minY = Math.min(minY, n.position.y)
    maxX = Math.max(maxX, n.position.x + NODE_W)
    maxY = Math.max(maxY, n.position.y + NODE_H)
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}

/** Member-id sets keyed by group id (one Set per group). */
export function memberSetsByGroup(groups: GroupDecl[]): Map<string, Set<string>> {
  return new Map(groups.map((g) => [g.id, new Set(g.nodeIds)]))
}

/** The group a node belongs to (at most one), or undefined if ungrouped. */
export function groupOfNode(groups: GroupDecl[], nodeId: string): GroupDecl | undefined {
  return groups.find((g) => g.nodeIds.includes(nodeId))
}

/** The single generic handle id on a module node (one target left, one source right share it). */
export const MODULE_PORT = 'module'

/** Project nodes/edges/groups into what the canvas should render given collapsed groups:
 *   - visibleNodes: the members of a COLLAPSED group are filtered out (expanded groups keep theirs).
 *   - moduleNodes: one entry per collapsed group, positioned at its bounds top-left.
 *   - syntheticEdges: boundary-crossing edges (exactly one end inside a collapsed group) re-pointed
 *     to the module id via the generic 'module' handle; edges fully inside a collapsed group are
 *     dropped; duplicate synthetic ids collapse to one edge. */
export function collapsedView(
  nodes: EditorNode[],
  edges: EditorEdge[],
  groups: GroupDecl[]
): {
  visibleNodes: EditorNode[]
  moduleNodes: Array<{ group: GroupDecl; position: { x: number; y: number }; memberCount: number }>
  syntheticEdges: Array<{
    id: string
    source: string
    sourcePort: string
    target: string
    targetPort: string
    groupEdge: true
  }>
} {
  const collapsed = groups.filter((g) => g.collapsed)
  const memberSets = memberSetsByGroup(collapsed)

  /** The collapsed group id that hides `nodeId`, if any (a node is in at most one group). */
  const collapsedGroupOf = (nodeId: string): string | undefined => {
    for (const [gid, set] of memberSets) if (set.has(nodeId)) return gid
    return undefined
  }
  const hidden = new Set<string>()
  for (const set of memberSets.values()) for (const id of set) hidden.add(id)

  const visibleNodes = nodes.filter((n) => !hidden.has(n.id))

  const moduleNodes = collapsed.map((group) => {
    const bounds = groupBounds(nodes, memberSets.get(group.id)!)
    return {
      group,
      position: { x: bounds.x, y: bounds.y },
      memberCount: group.nodeIds.length
    }
  })

  const syntheticById = new Map<
    string,
    {
      id: string
      source: string
      sourcePort: string
      target: string
      targetPort: string
      groupEdge: true
    }
  >()
  for (const e of edges) {
    const srcGroup = collapsedGroupOf(e.source)
    const tgtGroup = collapsedGroupOf(e.target)
    // Neither end inside a collapsed group → the edge renders as-is (not synthetic here).
    if (!srcGroup && !tgtGroup) continue
    // Both ends inside collapsed groups: an edge fully internal to ONE group is dropped; an edge
    // between TWO different collapsed groups becomes a module→module synthetic edge.
    if (srcGroup && tgtGroup) {
      if (srcGroup === tgtGroup) continue // internal edge dropped
      const id = 'grp:' + e.id
      syntheticById.set(id, {
        id,
        source: srcGroup,
        sourcePort: MODULE_PORT,
        target: tgtGroup,
        targetPort: MODULE_PORT,
        groupEdge: true
      })
      continue
    }
    // xor: exactly one end inside a collapsed group — re-point that end to the module id.
    const id = 'grp:' + e.id
    syntheticById.set(id, {
      id,
      source: srcGroup ? srcGroup : e.source,
      sourcePort: srcGroup ? MODULE_PORT : e.sourcePort,
      target: tgtGroup ? tgtGroup : e.target,
      targetPort: tgtGroup ? MODULE_PORT : e.targetPort,
      groupEdge: true
    })
  }

  return { visibleNodes, moduleNodes, syntheticEdges: [...syntheticById.values()] }
}
