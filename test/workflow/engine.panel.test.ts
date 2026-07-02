import { describe, it, expect } from 'vitest'
import { runWorkflow, panelTextOf } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge, NodeDescriptor } from '../../src/shared/workflow/types'

// Spec D4: a node with panel.show fills its collapsible output panel ON COMPLETION via
// ctx.emitPanel; nodes without the opt-in stay silent; skipped/failed nodes emit nothing.

const ctx = (emitted: Array<{ nodeId: string; delta: string }>): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: (nodeId, delta) => emitted.push({ nodeId, delta }),
  getNodeState: () => undefined,
  setNodeState: () => {}
})

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

const impls: NodeImpl[] = [
  {
    type: 'src',
    title: 'src',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'planner says: go left' } })
  },
  {
    type: 'gate',
    title: 'gate',
    inputs: [],
    outputs: [{ name: 'fire', type: 'Signal' }],
    run: () => ({ signals: [] }) // never fires → gated node is skipped
  },
  {
    type: 'gated',
    title: 'gated',
    inputs: [{ name: 'when', type: 'Signal' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'should never appear' } })
  },
  {
    type: 'sink',
    title: 'sink',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [],
    isMainOutputCapable: true,
    run: () => ({})
  }
]
const reg = createRegistry(impls)

describe('engine panel emission (spec D4)', () => {
  it('emits the completed output for panel.show nodes only', async () => {
    const emitted: Array<{ nodeId: string; delta: string }> = []
    const d = doc(
      [
        { id: 'a', type: 'src', panel: { show: true, label: 'Planner' } },
        { id: 'b', type: 'sink', isMainOutput: true }
      ],
      [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx(emitted))
    expect(res.ok).toBe(true)
    expect(emitted).toEqual([{ nodeId: 'a', delta: 'planner says: go left' }])
  })

  it('stays silent without the panel opt-in', async () => {
    const emitted: Array<{ nodeId: string; delta: string }> = []
    const d = doc(
      [
        { id: 'a', type: 'src' },
        { id: 'b', type: 'sink', isMainOutput: true }
      ],
      [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }]
    )
    await runWorkflow(d, reg, ctx(emitted))
    expect(emitted).toEqual([])
  })

  it('a skipped (signal-gated) node emits no panel even with panel.show', async () => {
    const emitted: Array<{ nodeId: string; delta: string }> = []
    const d = doc(
      [
        { id: 'a', type: 'src' },
        { id: 'g', type: 'gate' },
        { id: 'x', type: 'gated', panel: { show: true } },
        { id: 'b', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
        { from: { node: 'g', port: 'fire' }, to: { node: 'x', port: 'when' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx(emitted))
    expect(res.traces.find((t) => t.nodeId === 'x')?.status).toBe('skipped')
    expect(emitted).toEqual([])
  })
})

describe('panelTextOf', () => {
  const desc = (outputs: NodeDescriptor['outputs']): NodeDescriptor => ({
    type: 'x',
    title: 'x',
    inputs: [],
    outputs
  })

  it('joins Text ports', () => {
    expect(
      panelTextOf({ a: 'one', b: 'two' }, desc([
        { name: 'a', type: 'Text' },
        { name: 'b', type: 'Text' }
      ]))
    ).toBe('one\n\ntwo')
  })

  it('falls back to JSON of the first data port when no Text port has content', () => {
    expect(
      panelTextOf({ gen: { huge: true }, usage: { tokens: 5 } }, desc([
        { name: 'gen', type: 'Context' },
        { name: 'usage', type: 'Any' }
      ]))
    ).toBe(JSON.stringify({ tokens: 5 }, null, 2))
  })

  it('returns empty for nothing displayable', () => {
    expect(panelTextOf({}, desc([{ name: 'fire', type: 'Signal' }]))).toBe('')
  })
})
