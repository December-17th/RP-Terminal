// Pure editor model for the node-workflow React Flow editor (Phase 4 task 2). Maps a
// WorkflowDoc (src/shared/workflow/types) to plain canvas shapes and back, and gates
// connections. NO React / @xyflow/react imports here — only src/shared/workflow/* — so this
// stays vitest-testable and immune to renderer/main boundary drift (CLAUDE.md module
// boundaries; check:deps enforces `renderer` never importing `src/main`).
import {
  Edge,
  EdgeEnd,
  PortType,
  WorkflowDoc,
  portCompatible
} from '../../../../shared/workflow/types'

/** Structurally identical to main's `NodeTypeInfo` (src/main/services/nodes/catalog.ts) —
 *  redeclared locally rather than imported, since the renderer only ever sees this data over
 *  IPC and must not import from src/main (renderer boundary; check:deps would flag it). */
export interface EditorNodeType {
  type: string
  title: string
  inputs: { name: string; type: string }[]
  outputs: { name: string; type: string }[]
  isMainOutputCapable?: boolean
  configSchema?: Record<string, unknown>
}

export interface EditorNode {
  id: string
  type: string
  position: { x: number; y: number }
  config?: Record<string, unknown>
  isMainOutput?: boolean
}

export interface EditorEdge {
  id: string
  source: string
  sourcePort: string
  target: string
  targetPort: string
}

/** Matches the engine's edgeKey format (src/shared/workflow/graph.ts, src/main/services/
 *  workflowEngine.ts) so a future trace panel can reuse the same key. */
export const edgeId = (e: { from: EdgeEnd; to: EdgeEnd }): string =>
  `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`

const COLUMN_WIDTH = 260
const ROW_HEIGHT = 120
const ORIGIN = 40

/** Longest-path-from-any-root column layout (roots = column 0), doc order within a column.
 *  Bounded by node count so a cyclic (unvalidated) doc can't hang — falls back to doc-order
 *  columns instead. A validated doc can't be cyclic, but the editor edits unvalidated drafts. */
export function autoLayout(doc: WorkflowDoc): Map<string, { x: number; y: number }> {
  const ids = doc.nodes.map((n) => n.id)
  const indexOf = new Map(ids.map((id, i) => [id, i]))

  const col = new Map<string, number>()
  for (const id of ids) col.set(id, 0)

  let changed = true
  let iterations = 0
  const maxIterations = ids.length + 1
  while (changed && iterations <= maxIterations) {
    changed = false
    iterations++
    for (const e of doc.edges) {
      if (!indexOf.has(e.from.node) || !indexOf.has(e.to.node)) continue
      const fromCol = col.get(e.from.node)!
      const toCol = col.get(e.to.node)!
      if (toCol < fromCol + 1) {
        col.set(e.to.node, fromCol + 1)
        changed = true
      }
    }
  }

  const positions = new Map<string, { x: number; y: number }>()
  if (iterations > maxIterations) {
    // Cycle detected (columns never settled) — fall back to doc-order columns.
    ids.forEach((id, i) => {
      positions.set(id, { x: ORIGIN + i * COLUMN_WIDTH, y: ORIGIN })
    })
    return positions
  }

  // Assign row-within-column in doc order.
  const rowInColumn = new Map<number, number>()
  for (const id of ids) {
    const c = col.get(id)!
    const row = rowInColumn.get(c) ?? 0
    rowInColumn.set(c, row + 1)
    positions.set(id, { x: ORIGIN + c * COLUMN_WIDTH, y: ORIGIN + row * ROW_HEIGHT })
  }
  return positions
}

export function docToEditor(doc: WorkflowDoc): { nodes: EditorNode[]; edges: EditorEdge[] } {
  const layout = autoLayout(doc)
  const nodes: EditorNode[] = doc.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? layout.get(n.id) ?? { x: ORIGIN, y: ORIGIN },
    ...(n.config !== undefined ? { config: n.config } : {}),
    ...(n.isMainOutput !== undefined ? { isMainOutput: n.isMainOutput } : {})
  }))
  const edges: EditorEdge[] = doc.edges.map((e) => ({
    id: edgeId(e),
    source: e.from.node,
    sourcePort: e.from.port,
    target: e.to.node,
    targetPort: e.to.port
  }))
  return { nodes, edges }
}

export function editorToDoc(
  base: WorkflowDoc,
  nodes: EditorNode[],
  edges: EditorEdge[]
): WorkflowDoc {
  const outNodes = nodes.map((n) => {
    const hasConfig = n.config !== undefined && Object.keys(n.config).length > 0
    return {
      id: n.id,
      type: n.type,
      position: n.position,
      ...(hasConfig ? { config: n.config } : {}),
      ...(n.isMainOutput !== undefined ? { isMainOutput: n.isMainOutput } : {})
    }
  })
  const outEdges: Edge[] = edges.map((e) => ({
    from: { node: e.source, port: e.sourcePort },
    to: { node: e.target, port: e.targetPort }
  }))
  return {
    id: base.id,
    name: base.name,
    version: base.version,
    schemaVersion: base.schemaVersion,
    ...(base.description !== undefined ? { description: base.description } : {}),
    nodes: outNodes,
    edges: outEdges,
    ...(base.meta !== undefined ? { meta: base.meta } : {})
  }
}

export type ConnectVerdict =
  | { ok: true }
  | { ok: false; reason: 'incompatible' | 'occupied' | 'self' | 'missing-port' }

export function canConnect(
  types: Map<string, EditorNodeType>,
  nodes: EditorNode[],
  edges: EditorEdge[],
  from: { node: string; port: string },
  to: { node: string; port: string }
): ConnectVerdict {
  const fromNode = nodes.find((n) => n.id === from.node)
  const toNode = nodes.find((n) => n.id === to.node)
  const fromType = fromNode ? types.get(fromNode.type) : undefined
  const toType = toNode ? types.get(toNode.type) : undefined
  const fromPort = fromType?.outputs.find((p) => p.name === from.port)
  const toPort = toType?.inputs.find((p) => p.name === to.port)
  if (!fromPort || !toPort) return { ok: false, reason: 'missing-port' }

  if (from.node === to.node) return { ok: false, reason: 'self' }

  const occupied = edges.some((e) => e.target === to.node && e.targetPort === to.port)
  if (occupied) return { ok: false, reason: 'occupied' }

  if (!portCompatible(fromPort.type as PortType, toPort.type as PortType)) {
    return { ok: false, reason: 'incompatible' }
  }

  return { ok: true }
}
