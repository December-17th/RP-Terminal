import { describe, it, expect } from 'vitest'
import { topoOrder, GraphCycleError } from '../../src/shared/workflow/graph'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const node = (id: string): NodeInstance => ({ id, type: 't' })
const edge = (from: string, to: string): Edge => ({
  from: { node: from, port: 'out' },
  to: { node: to, port: 'in' }
})
const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('topoOrder', () => {
  it('orders a linear chain a->b->c', () => {
    const order = topoOrder(doc([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
  })

  it('includes disconnected nodes', () => {
    const order = topoOrder(doc([node('a'), node('b')], []))
    expect(order.sort()).toEqual(['a', 'b'])
  })

  it('collapses duplicate edges between the same node pair', () => {
    // Two edges a->b (different ports) must not inflate indegree into a false cycle.
    const order = topoOrder(
      doc(
        [node('a'), node('b')],
        [
          { from: { node: 'a', port: 'o1' }, to: { node: 'b', port: 'i1' } },
          { from: { node: 'a', port: 'o2' }, to: { node: 'b', port: 'i2' } }
        ]
      )
    )
    expect(order).toEqual(['a', 'b'])
  })

  it('throws GraphCycleError on a cycle', () => {
    expect(() => topoOrder(doc([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]))).toThrow(
      GraphCycleError
    )
  })

  it('throws GraphCycleError on a self-edge', () => {
    expect(() => topoOrder(doc([node('a')], [edge('a', 'a')]))).toThrow(GraphCycleError)
  })
})
