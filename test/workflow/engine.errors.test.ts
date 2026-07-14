import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, NodeRunFailure, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const ctx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

const impls: NodeImpl[] = [
  {
    type: 'boom',
    title: 'boom',
    inputs: [],
    outputs: [
      { name: 'out', type: 'Text' },
      { name: 'error', type: 'Error' }
    ],
    run: () => {
      throw new Error('kaboom')
    }
  },
  {
    type: 'handler',
    title: 'handler',
    inputs: [{ name: 'err', type: 'Error' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: (_ctx, inputs) => ({
      outputs: { out: 'handled:' + (inputs.err as { message: string }).message }
    })
  },
  {
    type: 'main',
    title: 'main',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    isMainOutputCapable: true,
    run: (_ctx, inputs) => ({ outputs: { out: inputs.in ?? 'reply' } })
  },
  {
    type: 'postboom',
    title: 'postboom',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'error', type: 'Error' }],
    run: () => {
      throw new Error('post failure')
    }
  },
  {
    type: 'classb',
    title: 'classb',
    inputs: [],
    outputs: [
      { name: 'out', type: 'Text' },
      { name: 'error', type: 'Error' }
    ],
    run: () => {
      throw new NodeRunFailure('B', 'validator failed: empty', 3, 'validator')
    }
  },
  // A2 dead-port affordance (plot-recall) — a fail-open node that matches throw-path error semantics
  // WITHOUT throwing (mirrors memory.recall). SUCCESS: produce block/report, declare `error` DEAD so a
  // wired error branch never fires on a good turn (no `undefined` delivered).
  {
    type: 'recallok',
    title: 'recallok',
    inputs: [],
    outputs: [
      { name: 'block', type: 'Text' },
      { name: 'report', type: 'Text' },
      { name: 'error', type: 'Error' }
    ],
    run: () => ({ outputs: { block: 'B', report: 'R' }, deadPorts: ['error'] })
  },
  // FAIL-OPEN: emit the error on `error`, declare the NON-error ports (block/report) dead so downstream
  // non-error branches are pruned, flag failedOpen, and NEVER throw (the turn proceeds).
  {
    type: 'recallfail',
    title: 'recallfail',
    inputs: [],
    outputs: [
      { name: 'block', type: 'Text' },
      { name: 'report', type: 'Text' },
      { name: 'error', type: 'Error' }
    ],
    run: () => ({
      outputs: { report: 'recall failed open: boom', error: { kind: 'A', message: 'boom', nodeId: 'x', attempts: 1 } },
      deadPorts: ['block', 'report'],
      failedOpen: true
    })
  },
  // A plain Text→Text consumer standing in for a downstream non-error branch (should be pruned/skipped
  // when the port feeding it is declared dead).
  {
    type: 'sink',
    title: 'sink',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: (_ctx, inputs) => ({ outputs: { out: 'got:' + String(inputs.in) } })
  }
]
const reg = createRegistry(impls)

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('runWorkflow — error routing', () => {
  it('routes a throw down a wired error branch and keeps the run ok', async () => {
    // boom throws -> error edge -> handler -> main
    const d = doc(
      [
        { id: 'b', type: 'boom' },
        { id: 'h', type: 'handler' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [
        { from: { node: 'b', port: 'error' }, to: { node: 'h', port: 'err' } },
        { from: { node: 'h', port: 'out' }, to: { node: 'm', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    expect(res.traces.find((t) => t.nodeId === 'b')?.status).toBe('failed')
    expect(res.outputs.get('h')).toEqual({ out: 'handled:kaboom' })
  })

  it('fails the run when an unwired pre-phase node throws', async () => {
    // boom is the main output's ancestor with no error edge → fatal
    const d = doc(
      [
        { id: 'b', type: 'boom' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [{ from: { node: 'b', port: 'out' }, to: { node: 'm', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(false)
    expect(res.error?.nodeId).toBe('b')
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).not.toBe('ran')
  })

  it('carries NodeRunFailure kind/attempts/code onto the routed error value (spec §10)', async () => {
    const d = doc(
      [
        { id: 'v', type: 'classb' },
        { id: 'h', type: 'handler' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [
        { from: { node: 'v', port: 'error' }, to: { node: 'h', port: 'err' } },
        { from: { node: 'h', port: 'out' }, to: { node: 'm', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    expect(res.outputs.get('v')?.error).toMatchObject({
      kind: 'B',
      code: 'validator',
      attempts: 3,
      nodeId: 'v',
      message: 'validator failed: empty'
    })
    expect(res.traces.find((t) => t.nodeId === 'v')?.error?.kind).toBe('B')
  })

  it('fails open when an unwired post-phase node throws', async () => {
    // main output runs; a downstream post node throws with no error edge → recorded, run stays ok
    const d = doc(
      [
        { id: 'm', type: 'main', isMainOutput: true },
        { id: 'x', type: 'postboom' }
      ],
      [{ from: { node: 'm', port: 'out' }, to: { node: 'x', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    expect(res.traces.find((t) => t.nodeId === 'x')?.status).toBe('failed')
  })
})

describe('runWorkflow — A2 dead-port / fail-open affordance', () => {
  it('a successful fail-open node declares its error port dead → wired error branch is pruned (no undefined delivered)', async () => {
    // recallok succeeds: block → main.in (live), error → handler (must be pruned). The handler's only
    // incoming edge is dead, so it is SKIPPED and never receives an `undefined` error value.
    const d = doc(
      [
        { id: 'r', type: 'recallok' },
        { id: 'h', type: 'handler' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [
        { from: { node: 'r', port: 'block' }, to: { node: 'm', port: 'in' } },
        { from: { node: 'r', port: 'error' }, to: { node: 'h', port: 'err' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    // The error branch never ran — its edge was pruned by deadPorts.
    expect(res.traces.find((t) => t.nodeId === 'h')?.status).toBe('skipped')
    expect(res.outputs.get('h')).toBeUndefined()
    // The real (block) output still flowed to main.
    expect(res.outputs.get('m')).toEqual({ out: 'B' })
    // recallok ran cleanly (not flagged failed-open).
    expect(res.traces.find((t) => t.nodeId === 'r')?.failedOpen).toBeFalsy()
  })

  it('a fail-open failure prunes the non-error branch, fires the error branch, sets failedOpen, and keeps the run going', async () => {
    // recallfail: block → sink (a downstream non-error branch, must be pruned/skipped), error → handler
    // (live, fires). main is standalone so the turn always produces a reply. The node NEVER throws.
    const d = doc(
      [
        { id: 'r', type: 'recallfail' },
        { id: 's', type: 'sink' },
        { id: 'h', type: 'handler' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [
        { from: { node: 'r', port: 'block' }, to: { node: 's', port: 'in' } },
        { from: { node: 'r', port: 'error' }, to: { node: 'h', port: 'err' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    // The turn still produced a reply (main is unaffected by the fail-open).
    expect(res.outputs.get('m')).toEqual({ out: 'reply' })
    // The non-error (block) branch was pruned → sink skipped, never got `undefined`.
    expect(res.traces.find((t) => t.nodeId === 's')?.status).toBe('skipped')
    expect(res.outputs.get('s')).toBeUndefined()
    // The error branch fired and received the NodeError value.
    expect(res.outputs.get('h')).toEqual({ out: 'handled:boom' })
    // The node RAN (not a hard 'failed') but is flagged failed-open for the warning tint (A3).
    const rt = res.traces.find((t) => t.nodeId === 'r')
    expect(rt?.status).toBe('ran')
    expect(rt?.failedOpen).toBe(true)
  })
})
