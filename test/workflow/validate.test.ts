import { describe, it, expect } from 'vitest'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { WorkflowDoc, NodeDescriptor, NodeInstance, Edge } from '../../src/shared/workflow/types'

const descriptors = new Map<string, NodeDescriptor>([
  ['src', { type: 'src', title: 'Src', inputs: [], outputs: [{ name: 'out', type: 'Text' }] }],
  [
    'sink',
    {
      type: 'sink',
      title: 'Sink',
      inputs: [{ name: 'in', type: 'Text' }],
      outputs: [],
      isMainOutputCapable: true
    }
  ]
])

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

const good = (): WorkflowDoc =>
  doc(
    [
      { id: 'a', type: 'src' },
      { id: 'b', type: 'sink', isMainOutput: true }
    ],
    [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }]
  )

describe('validateWorkflow', () => {
  it('accepts a well-formed graph', () => {
    expect(validateWorkflow(good(), descriptors)).toEqual({ ok: true })
  })

  it('rejects an unknown node type', () => {
    const d = good()
    d.nodes[0].type = 'nope'
    const r = validateWorkflow(d, descriptors)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.errors.some((e) => e.code === 'UNKNOWN_TYPE')).toBe(true)
  })

  it('rejects an edge to a non-existent port', () => {
    const d = good()
    d.edges[0].to.port = 'missing'
    const r = validateWorkflow(d, descriptors)
    expect(r.ok === false && r.errors.some((e) => e.code === 'EDGE_PORT')).toBe(true)
  })

  it('rejects incompatible port types', () => {
    const withVars = new Map(descriptors)
    withVars.set('vsrc', {
      type: 'vsrc',
      title: 'V',
      inputs: [],
      outputs: [{ name: 'out', type: 'Vars' }]
    })
    const d = doc(
      [
        { id: 'a', type: 'vsrc' },
        { id: 'b', type: 'sink', isMainOutput: true }
      ],
      [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }]
    )
    const r = validateWorkflow(d, withVars)
    expect(r.ok === false && r.errors.some((e) => e.code === 'PORT_TYPE')).toBe(true)
  })

  it('requires exactly one main-output node', () => {
    const d = good()
    d.nodes[1].isMainOutput = false
    const r = validateWorkflow(d, descriptors)
    expect(r.ok === false && r.errors.some((e) => e.code === 'MAIN_OUTPUT')).toBe(true)
  })

  it('rejects an edge to a non-existent node', () => {
    const d = good()
    d.edges[0].to.node = 'missing'
    const r = validateWorkflow(d, descriptors)
    expect(r.ok === false && r.errors.some((e) => e.code === 'EDGE_NODE')).toBe(true)
  })

  it('flags duplicate node ids without a spurious CYCLE error', () => {
    const d = doc(
      [
        { id: 'a', type: 'src' },
        { id: 'b', type: 'sink', isMainOutput: true },
        { id: 'b', type: 'sink' }
      ],
      [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }]
    )
    const r = validateWorkflow(d, descriptors)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.errors.some((e) => e.code === 'DUP_NODE_ID')).toBe(true)
    expect(r.ok === false && r.errors.some((e) => e.code === 'CYCLE')).toBe(false)
  })

  it('rejects a cycle', () => {
    const cyc = new Map(descriptors)
    cyc.set('mid', {
      type: 'mid',
      title: 'Mid',
      inputs: [{ name: 'in', type: 'Text' }],
      outputs: [{ name: 'out', type: 'Text' }],
      isMainOutputCapable: true
    })
    const d = doc(
      [
        { id: 'a', type: 'mid', isMainOutput: true },
        { id: 'b', type: 'mid' }
      ],
      [
        { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
        { from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' } }
      ]
    )
    const r = validateWorkflow(d, cyc)
    expect(r.ok === false && r.errors.some((e) => e.code === 'CYCLE')).toBe(true)
  })
})
