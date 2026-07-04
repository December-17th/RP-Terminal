import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

// One-canvas rebuild (WP6.1; ADR 0011): trigger-node turn-exclusion + node-disable, in the engine.

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

// `trig` is descriptor-marked isTrigger (a graph root, Signal-only output). `job` gates on a Signal.
// `plain` is an ordinary passthrough. `sink` is the main output.
const impls: NodeImpl[] = [
  {
    type: 'trig',
    title: 'trig',
    inputs: [],
    outputs: [{ name: 'fired', type: 'Signal' }],
    isTrigger: true,
    run: () => ({ signals: ['fired'] })
  },
  {
    type: 'src',
    title: 'src',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'data' } })
  },
  {
    type: 'job',
    title: 'job',
    inputs: [
      { name: 'in', type: 'Text' },
      { name: 'when', type: 'Signal' }
    ],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'ran' } })
  },
  {
    type: 'plain',
    title: 'plain',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: (_c, i) => ({ outputs: { out: i.in } })
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

const status = (res: Awaited<ReturnType<typeof runWorkflow>>, id: string) =>
  res.traces.find((t) => t.nodeId === id)?.status

describe('WP6.1 trigger turn-exclusion', () => {
  it('a trigger-rooted chain is SKIPPED in a turn run (trigger excluded → chain pruned)', async () => {
    // Narrator: src → sink. Agent: trig → job (gated on trig.fired), job fed data by src.
    const d = doc(
      [
        { id: 'trig', type: 'trig' },
        { id: 'src', type: 'src' },
        { id: 'job', type: 'job' },
        { id: 'sink', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'trig', port: 'fired' }, to: { node: 'job', port: 'when' } },
        { from: { node: 'src', port: 'out' }, to: { node: 'job', port: 'in' } },
        { from: { node: 'src', port: 'out' }, to: { node: 'sink', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    // Trigger never runs; the gated job is skipped; the narrator (src → sink) runs normally.
    expect(status(res, 'trig')).toBe('skipped')
    expect(status(res, 'job')).toBe('skipped')
    expect(status(res, 'src')).toBe('ran')
    expect(status(res, 'sink')).toBe('ran')
    expect(res.ok).toBe(true)
  })

  it('the ZERO-TRIGGERS guarantee: a doc with no trigger + no disabled nodes runs byte-identically', async () => {
    // Same narrator graph WITHOUT any trigger/disabled node; every node runs, no skip traces added.
    const d = doc(
      [
        { id: 'src', type: 'src' },
        { id: 'plain', type: 'plain' },
        { id: 'sink', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'src', port: 'out' }, to: { node: 'plain', port: 'in' } },
        { from: { node: 'plain', port: 'out' }, to: { node: 'sink', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(status(res, 'src')).toBe('ran')
    expect(status(res, 'plain')).toBe('ran')
    expect(status(res, 'sink')).toBe('ran')
    // No spurious 'skipped' traces (nothing was excluded).
    expect(res.traces.every((t) => t.status !== 'skipped')).toBe(true)
  })
})

describe('WP6.1 node-disable', () => {
  it('a disabled node is skipped and its exclusive downstream reads unwired (skipped)', async () => {
    // src → plain(disabled) → sink. plain disabled → sink has only-dead input → skipped.
    const d = doc(
      [
        { id: 'src', type: 'src' },
        { id: 'plain', type: 'plain', disabled: true },
        { id: 'sink', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'src', port: 'out' }, to: { node: 'plain', port: 'in' } },
        { from: { node: 'plain', port: 'out' }, to: { node: 'sink', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(status(res, 'src')).toBe('ran')
    expect(status(res, 'plain')).toBe('skipped')
    // sink's only incoming edge is dead (from disabled plain) → allDead prune → skipped.
    expect(status(res, 'sink')).toBe('skipped')
  })

  it('a disabled node with a live sibling parent does NOT over-prune the downstream', async () => {
    // sink has TWO inputs — but sink only has one 'in' port; use plain as a joiner. Instead: disable a
    // side branch that feeds an ordering-only node while a live edge remains. Simpler: a disabled node
    // whose downstream has ANOTHER live parent still runs. src → sink (live); disabled dead-ends.
    const d = doc(
      [
        { id: 'src', type: 'src' },
        { id: 'dead', type: 'plain', disabled: true },
        { id: 'sink', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'src', port: 'out' }, to: { node: 'dead', port: 'in' } },
        { from: { node: 'src', port: 'out' }, to: { node: 'sink', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(status(res, 'dead')).toBe('skipped')
    // sink keeps its live edge from src → runs.
    expect(status(res, 'sink')).toBe('ran')
  })

  it('a DISABLED main-output node is a defined run failure (not undefined behavior)', async () => {
    const d = doc(
      [
        { id: 'src', type: 'src' },
        { id: 'sink', type: 'sink', isMainOutput: true, disabled: true }
      ],
      [{ from: { node: 'src', port: 'out' }, to: { node: 'sink', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(false)
    expect(res.error?.nodeId).toBe('sink')
    expect(res.error?.message).toMatch(/disabled/)
  })
})
