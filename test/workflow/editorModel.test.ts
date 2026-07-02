import { describe, it, expect } from 'vitest'
import {
  edgeId,
  docToEditor,
  editorToDoc,
  autoLayout,
  canConnect,
  EditorNode,
  EditorEdge,
  EditorNodeType
} from '../../src/renderer/src/components/workflow/editorModel'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'
import { DEFAULT_GRAPH } from '../../src/main/services/nodes/builtin/defaultGraph'

const node = (id: string, extra: Partial<NodeInstance> = {}): NodeInstance => ({
  id,
  type: 't',
  ...extra
})
const edge = (from: string, to: string, fromPort = 'out', toPort = 'in'): Edge => ({
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort }
})
const doc = (
  nodes: NodeInstance[],
  edges: Edge[],
  extra: Partial<WorkflowDoc> = {}
): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges,
  ...extra
})

describe('edgeId', () => {
  it('formats as from.node:from.port->to.node:to.port (matches engine edgeKey)', () => {
    expect(edgeId(edge('a', 'b', 'out1', 'in1'))).toBe('a:out1->b:in1')
  })
})

describe('docToEditor / editorToDoc round-trip', () => {
  it('round-trips DEFAULT_GRAPH nodes/edges (positions added)', () => {
    const { nodes, edges } = docToEditor(DEFAULT_GRAPH)

    // Every node present, with a position (auto-laid-out since DEFAULT_GRAPH has none).
    expect(nodes).toHaveLength(DEFAULT_GRAPH.nodes.length)
    for (const n of nodes) {
      expect(n.position).toBeDefined()
      expect(typeof n.position.x).toBe('number')
      expect(typeof n.position.y).toBe('number')
    }

    // isMainOutput passes through.
    const write = nodes.find((n) => n.id === 'write')
    expect(write?.isMainOutput).toBe(true)

    // Edges round-trip 1:1.
    expect(edges).toHaveLength(DEFAULT_GRAPH.edges.length)

    const rebuilt = editorToDoc(DEFAULT_GRAPH, nodes, edges)

    // Same node ids/types/isMainOutput, in the same order.
    expect(
      rebuilt.nodes.map((n) => ({ id: n.id, type: n.type, isMainOutput: n.isMainOutput }))
    ).toEqual(
      DEFAULT_GRAPH.nodes.map((n) => ({ id: n.id, type: n.type, isMainOutput: n.isMainOutput }))
    )
    // Positions were added (DEFAULT_GRAPH nodes have none).
    for (const n of rebuilt.nodes) {
      expect(n.position).toBeDefined()
    }
    // Edges reproduce exactly.
    expect(rebuilt.edges).toEqual(DEFAULT_GRAPH.edges)
    // Base fields preserved.
    expect(rebuilt.id).toBe(DEFAULT_GRAPH.id)
    expect(rebuilt.name).toBe(DEFAULT_GRAPH.name)
    expect(rebuilt.version).toBe(DEFAULT_GRAPH.version)
    expect(rebuilt.schemaVersion).toBe(DEFAULT_GRAPH.schemaVersion)
    expect(rebuilt.description).toBe(DEFAULT_GRAPH.description)
  })

  it('preserves existing positions instead of re-laying-out', () => {
    const d = doc([node('a', { position: { x: 7, y: 9 } }), node('b')], [])
    const { nodes } = docToEditor(d)
    const a = nodes.find((n) => n.id === 'a')!
    expect(a.position).toEqual({ x: 7, y: 9 })
  })

  it('passes through config and isMainOutput', () => {
    const d = doc([node('a', { config: { foo: 1 }, isMainOutput: true }), node('b')], [])
    const { nodes } = docToEditor(d)
    const a = nodes.find((n) => n.id === 'a')!
    expect(a.config).toEqual({ foo: 1 })
    expect(a.isMainOutput).toBe(true)
    const b = nodes.find((n) => n.id === 'b')!
    expect(b.config).toBeUndefined()
    expect(b.isMainOutput).toBeUndefined()
  })

  it('editorToDoc drops config when undefined or {}', () => {
    const base = doc([node('a'), node('b')], [])
    const editorNodes: EditorNode[] = [
      { id: 'a', type: 't', position: { x: 0, y: 0 }, config: {} },
      { id: 'b', type: 't', position: { x: 0, y: 0 }, config: { keep: true } }
    ]
    const rebuilt = editorToDoc(base, editorNodes, [])
    const a = rebuilt.nodes.find((n) => n.id === 'a')!
    const b = rebuilt.nodes.find((n) => n.id === 'b')!
    expect(a.config).toBeUndefined()
    expect(b.config).toEqual({ keep: true })
  })

  it('editorToDoc writes position on every node', () => {
    const base = doc([node('a')], [])
    const editorNodes: EditorNode[] = [{ id: 'a', type: 't', position: { x: 12, y: 34 } }]
    const rebuilt = editorToDoc(base, editorNodes, [])
    expect(rebuilt.nodes[0].position).toEqual({ x: 12, y: 34 })
  })

  it('preserves node panel config through a docToEditor -> editorToDoc round-trip (alongside config)', () => {
    const d = doc(
      [node('a', { panel: { show: true, label: 'Plan' }, config: { template: 'x' } })],
      []
    )
    const { nodes } = docToEditor(d)
    const a = nodes.find((n) => n.id === 'a')!
    expect(a.panel).toEqual({ show: true, label: 'Plan' })
    expect(a.config).toEqual({ template: 'x' })

    const rebuilt = editorToDoc(d, nodes, [])
    const ra = rebuilt.nodes.find((n) => n.id === 'a')!
    expect(ra.panel).toEqual({ show: true, label: 'Plan' })
    expect(ra.config).toEqual({ template: 'x' })
  })

  it('preserves doc.kind through a docToEditor -> editorToDoc round-trip (plan-QA blocker: editorToDoc is a field-by-field literal that does not spread the base doc)', () => {
    const d = doc([node('a')], [], { kind: 'subgraph' })
    const { nodes, edges } = docToEditor(d)
    const rebuilt = editorToDoc(d, nodes, edges)
    expect(rebuilt.kind).toBe('subgraph')
  })

  it('omits kind when the base doc has none (turn doc, the default)', () => {
    const d = doc([node('a')], [])
    const { nodes, edges } = docToEditor(d)
    const rebuilt = editorToDoc(d, nodes, edges)
    expect(rebuilt.kind).toBeUndefined()
  })
})

describe('autoLayout', () => {
  it('places DEFAULT_GRAPH nodes by longest-path column (ctx=0, chain deepens, memory chain past write)', () => {
    const layout = autoLayout(DEFAULT_GRAPH)

    const colOf = (id: string): number => {
      const pos = layout.get(id)!
      return Math.round((pos.x - 40) / 260)
    }

    expect(colOf('ctx')).toBe(0)
    expect(colOf('recall')).toBeGreaterThan(colOf('ctx'))
    expect(colOf('assemble')).toBeGreaterThan(colOf('recall'))
    expect(colOf('llm')).toBeGreaterThan(colOf('assemble'))
    expect(colOf('parse')).toBeGreaterThan(colOf('llm'))
    expect(colOf('apply')).toBeGreaterThan(colOf('parse'))
    expect(colOf('write')).toBeGreaterThan(colOf('apply'))

    // The decomposed memory chain sits PAST write (the write.floor → gate ordering edge:
    // compaction only after the floor is persisted); write is the deepest pre-phase node.
    const maxCol = Math.max(...DEFAULT_GRAPH.nodes.map((n) => colOf(n.id)))
    expect(colOf('gate')).toBeGreaterThan(colOf('write'))
    expect(colOf('extract')).toBeGreaterThan(colOf('gate'))
    expect(colOf('memwrite')).toBeGreaterThan(colOf('extract'))
    expect(colOf('log-write')).toBe(maxCol)

    // x/y spacing formula.
    for (const n of DEFAULT_GRAPH.nodes) {
      const pos = layout.get(n.id)!
      expect(pos.x).toBe(40 + colOf(n.id) * 260)
      expect(pos.y).toBeGreaterThanOrEqual(40)
    }
  })

  it('is deterministic across repeated calls', () => {
    const l1 = autoLayout(DEFAULT_GRAPH)
    const l2 = autoLayout(DEFAULT_GRAPH)
    for (const n of DEFAULT_GRAPH.nodes) {
      expect(l1.get(n.id)).toEqual(l2.get(n.id))
    }
  })

  it('terminates and falls back to doc-order columns on a cyclic doc', () => {
    const cyclic = doc(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    )
    const layout = autoLayout(cyclic)
    expect(layout.size).toBe(3)
    // Fallback: doc order -> columns 0,1,2.
    expect(layout.get('a')).toEqual({ x: 40 + 0 * 260, y: 40 })
    expect(layout.get('b')).toEqual({ x: 40 + 1 * 260, y: 40 })
    expect(layout.get('c')).toEqual({ x: 40 + 2 * 260, y: 40 })
  })
})

describe('canConnect', () => {
  const types = new Map<string, EditorNodeType>([
    [
      'src',
      {
        type: 'src',
        title: 'Source',
        inputs: [],
        outputs: [{ name: 'out', type: 'Text' }]
      }
    ],
    [
      'dst',
      {
        type: 'dst',
        title: 'Dest',
        inputs: [
          { name: 'in', type: 'Text' },
          { name: 'other', type: 'Messages' }
        ],
        outputs: [{ name: 'out2', type: 'Text' }]
      }
    ]
  ])

  const nodes: EditorNode[] = [
    { id: 'a', type: 'src', position: { x: 0, y: 0 } },
    { id: 'b', type: 'dst', position: { x: 0, y: 0 } },
    { id: 'c', type: 'dst', position: { x: 0, y: 0 } }
  ]

  it('ok: compatible types, unoccupied input, different nodes', () => {
    const verdict = canConnect(
      types,
      nodes,
      [],
      { node: 'a', port: 'out' },
      { node: 'b', port: 'in' }
    )
    expect(verdict).toEqual({ ok: true })
  })

  it('missing-port: unknown node type', () => {
    const badNodes: EditorNode[] = [
      ...nodes,
      { id: 'z', type: 'unknown', position: { x: 0, y: 0 } }
    ]
    const verdict = canConnect(
      types,
      badNodes,
      [],
      { node: 'z', port: 'out' },
      { node: 'b', port: 'in' }
    )
    expect(verdict).toEqual({ ok: false, reason: 'missing-port' })
  })

  it('missing-port: unknown port name', () => {
    const verdict = canConnect(
      types,
      nodes,
      [],
      { node: 'a', port: 'nope' },
      { node: 'b', port: 'in' }
    )
    expect(verdict).toEqual({ ok: false, reason: 'missing-port' })
  })

  it('self: source node === target node', () => {
    const verdict = canConnect(
      types,
      nodes,
      [],
      { node: 'b', port: 'out2' },
      { node: 'b', port: 'in' }
    )
    expect(verdict).toEqual({ ok: false, reason: 'self' })
  })

  it('occupied: target input port already has an edge (FANIN)', () => {
    const existing: EditorEdge[] = [
      { id: edgeId(edge('a', 'b')), source: 'a', sourcePort: 'out', target: 'b', targetPort: 'in' }
    ]
    const verdict = canConnect(
      types,
      nodes,
      existing,
      { node: 'c', port: 'out2' },
      { node: 'b', port: 'in' }
    )
    expect(verdict).toEqual({ ok: false, reason: 'occupied' })
  })

  it('incompatible: port types do not match', () => {
    const verdict = canConnect(
      types,
      nodes,
      [],
      { node: 'a', port: 'out' },
      { node: 'b', port: 'other' }
    )
    expect(verdict).toEqual({ ok: false, reason: 'incompatible' })
  })
})
