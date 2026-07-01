import { describe, it, expect } from 'vitest'
import { runWorkflow, WorkflowValidationError } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

// --- test harness ---------------------------------------------------------
const ctx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
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

// nodes: `src` emits a constant; `upper` uppercases its `in`; `sink` records its `in` (main output);
// `gate` fires exactly one of its two Signal outputs based on config.which.
const impls: NodeImpl[] = [
  {
    type: 'src',
    title: 'src',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'hi' } })
  },
  {
    type: 'upper',
    title: 'upper',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: (_ctx, inputs) => ({ outputs: { out: String(inputs.in).toUpperCase() } })
  },
  {
    type: 'sink',
    title: 'sink',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [],
    isMainOutputCapable: true,
    run: () => ({})
  },
  {
    type: 'gate',
    title: 'gate',
    inputs: [],
    outputs: [
      { name: 'then', type: 'Signal' },
      { name: 'else', type: 'Signal' }
    ],
    run: (_ctx, _inputs) => ({ signals: ['then'] })
  },
  {
    // a branch target: gated by a Signal input, emits Text downstream
    type: 'branchTarget',
    title: 'branchTarget',
    inputs: [{ name: 'in', type: 'Signal' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'ran' } })
  }
]
const reg = createRegistry(impls)

describe('runWorkflow — core', () => {
  it('throws WorkflowValidationError on an invalid graph', async () => {
    // zero main-output nodes → invalid
    const d = doc([{ id: 's', type: 'src' }], [])
    await expect(runWorkflow(d, reg, ctx())).rejects.toBeInstanceOf(WorkflowValidationError)
  })

  it('runs a linear graph and wires outputs to downstream inputs', async () => {
    const d = doc(
      [
        { id: 's', type: 'src' },
        { id: 'u', type: 'upper' },
        { id: 'k', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 's', port: 'out' }, to: { node: 'u', port: 'in' } },
        { from: { node: 'u', port: 'out' }, to: { node: 'k', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    expect(res.outputs.get('u')).toEqual({ out: 'HI' })
    expect(res.traces.find((t) => t.nodeId === 'k')?.status).toBe('ran')
  })

  it('prunes the branch of a Signal port that did not fire', async () => {
    // gate fires `then`; the `else`-fed node must be skipped, the `then`-fed node runs.
    const d = doc(
      [
        { id: 'g', type: 'gate' },
        { id: 'a', type: 'branchTarget' },
        { id: 'b', type: 'branchTarget' },
        { id: 'k', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'g', port: 'then' }, to: { node: 'a', port: 'in' } },
        { from: { node: 'g', port: 'else' }, to: { node: 'b', port: 'in' } },
        { from: { node: 'a', port: 'out' }, to: { node: 'k', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'a')?.status).toBe('ran')
    expect(res.traces.find((t) => t.nodeId === 'b')?.status).toBe('skipped')
  })
})
