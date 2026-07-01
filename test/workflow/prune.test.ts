import { describe, it, expect } from 'vitest'
import { prunedNodes } from '../../src/shared/workflow/graph'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const node = (id: string): NodeInstance => ({ id, type: 't' })
const e = (from: string, fp: string, to: string, tp: string): Edge => ({
  from: { node: from, port: fp },
  to: { node: to, port: tp }
})
const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('prunedNodes', () => {
  it('prunes a node whose only feeder edge is inactive, and propagates downstream', () => {
    // gate --sig--> job --> sink ; gate's signal did not fire
    const edges = [e('gate', 'sig', 'job', 'in'), e('job', 'out', 'sink', 'in')]
    const pruned = prunedNodes(doc([node('gate'), node('job'), node('sink')], edges), [edges[0]])
    expect(pruned).toEqual(new Set(['job', 'sink']))
  })

  it('does not prune a node that still has a live input', () => {
    // live --> merge ; gate --sig(dead)--> merge  => merge survives (one live input)
    const edges = [e('live', 'out', 'merge', 'a'), e('gate', 'sig', 'merge', 'b')]
    const pruned = prunedNodes(doc([node('live'), node('gate'), node('merge')], edges), [edges[1]])
    expect(pruned.has('merge')).toBe(false)
  })

  it('never prunes root nodes (no incoming edges)', () => {
    const pruned = prunedNodes(doc([node('root')], []), [])
    expect(pruned.size).toBe(0)
  })

  it('returns empty when nothing is inactive', () => {
    const edges = [e('a', 'out', 'b', 'in')]
    const pruned = prunedNodes(doc([node('a'), node('b')], edges), [])
    expect(pruned.size).toBe(0)
  })
})
