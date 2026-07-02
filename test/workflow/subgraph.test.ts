import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runSubgraph } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'
import { subgraphInput, subgraphOutput } from '../../src/main/services/nodes/builtin/subgraphNodes'

const doc = (
  nodes: NodeInstance[],
  edges: Edge[],
  extra: Partial<WorkflowDoc> = {}
): WorkflowDoc => ({
  id: 'sub',
  name: 'sub',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges,
  kind: 'subgraph',
  ...extra
})

// `upper` uppercases its Text input; `gate` fires `fire` iff config.fire; `boom` always throws
// (unwired = fatal, wired = routed error, matching runWorkflow's own semantics).
const impls: NodeImpl[] = [
  subgraphInput,
  subgraphOutput,
  {
    type: 'upper',
    title: 'upper',
    inputs: [{ name: 'in', type: 'Any' }],
    outputs: [{ name: 'out', type: 'Any' }],
    run: (_ctx, inputs) => ({ outputs: { out: String(inputs.in).toUpperCase() } })
  },
  {
    type: 'gate',
    title: 'gate',
    inputs: [],
    outputs: [{ name: 'fire', type: 'Signal' }],
    run: (_c, _i, node) => ({ signals: node.config.fire ? ['fire'] : [] })
  },
  {
    type: 'gated',
    title: 'gated',
    inputs: [
      { name: 'in', type: 'Any' },
      { name: 'when', type: 'Signal' }
    ],
    outputs: [{ name: 'out', type: 'Any' }],
    run: (_ctx, inputs) => ({ outputs: { out: inputs.in } })
  },
  {
    type: 'boom',
    title: 'boom',
    inputs: [],
    outputs: [
      { name: 'out', type: 'Any' },
      { name: 'error', type: 'Error' }
    ],
    run: () => {
      throw new Error('inner kaboom')
    }
  },
  {
    type: 'handler',
    title: 'handler',
    inputs: [{ name: 'err', type: 'Error' }],
    outputs: [{ name: 'out', type: 'Any' }],
    run: (_ctx, inputs) => ({ outputs: { out: 'handled:' + (inputs.err as any).message } })
  },
  {
    type: 'stateReader',
    title: 'stateReader',
    inputs: [],
    outputs: [{ name: 'out', type: 'Any' }],
    run: (ctx, _inputs, node) => {
      ctx.setNodeState(node.id, 'wrote')
      return { outputs: { out: ctx.getNodeState(node.id) } }
    }
  }
]
const reg = createRegistry(impls)

const baseCtx = (overrides: Partial<RunContext> = {}): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {},
  ...overrides
})

describe('runSubgraph', () => {
  it('seeds boundary inputs and collects boundary outputs (in1 -> transform -> out1)', async () => {
    const d = doc(
      [
        { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
        { id: 'up', type: 'upper' },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      [
        { from: { node: 'bin', port: 'value' }, to: { node: 'up', port: 'in' } },
        { from: { node: 'up', port: 'out' }, to: { node: 'bout', port: 'value' } }
      ]
    )
    const res = await runSubgraph(d, reg, baseCtx(), { in1: 'hello' })
    expect(res.outputs).toEqual({ out1: 'HELLO' })
    expect(res.fatal).toBeUndefined()
    expect(res.aborted).toBe(false)
  })

  it('signal gating works inside a sub-graph: a gated inner node skipped means collect is not called', async () => {
    const d = doc(
      [
        { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
        { id: 'g', type: 'gate', config: { fire: false } },
        { id: 'gd', type: 'gated' },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      [
        { from: { node: 'bin', port: 'value' }, to: { node: 'gd', port: 'in' } },
        { from: { node: 'g', port: 'fire' }, to: { node: 'gd', port: 'when' } },
        { from: { node: 'gd', port: 'out' }, to: { node: 'bout', port: 'value' } }
      ]
    )
    const res = await runSubgraph(d, reg, baseCtx(), { in1: 'x' })
    expect(res.outputs).toEqual({})
    expect(res.traces.find((t) => t.nodeId === 'gd')?.status).toBe('skipped')
  })

  it('an unwired inner failure returns fatal (the wrapper is expected to throw from it)', async () => {
    const d = doc(
      [
        { id: 'b', type: 'boom' },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      [{ from: { node: 'b', port: 'out' }, to: { node: 'bout', port: 'value' } }]
    )
    const res = await runSubgraph(d, reg, baseCtx(), {})
    expect(res.fatal).toMatchObject({ nodeId: 'b', message: 'inner kaboom' })
    expect(res.outputs).toEqual({})
  })

  it('a wired inner error port routes normally — no fatal, the handled value is collected', async () => {
    const d = doc(
      [
        { id: 'b', type: 'boom' },
        { id: 'h', type: 'handler' },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      [
        { from: { node: 'b', port: 'error' }, to: { node: 'h', port: 'err' } },
        { from: { node: 'h', port: 'out' }, to: { node: 'bout', port: 'value' } }
      ]
    )
    const res = await runSubgraph(d, reg, baseCtx(), {})
    expect(res.fatal).toBeUndefined()
    expect(res.outputs).toEqual({ out1: 'handled:inner kaboom' })
  })

  it('node-state prefixing: inner getNodeState/setNodeState reach the parent ctx as passed (spy)', async () => {
    const getSpy = vi.fn(() => undefined)
    const setSpy = vi.fn()
    const d = doc(
      [
        { id: 'sr', type: 'stateReader' },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      [{ from: { node: 'sr', port: 'out' }, to: { node: 'bout', port: 'value' } }]
    )
    // runSubgraph itself does NOT prefix node-state — that's the wrapper's (subgraph.call's)
    // job (plan §4.7). Here we assert runSubgraph passes ctx through untouched otherwise.
    await runSubgraph(d, reg, baseCtx({ getNodeState: getSpy, setNodeState: setSpy }), {})
    expect(setSpy).toHaveBeenCalledWith('sr', 'wrote')
    expect(getSpy).toHaveBeenCalledWith('sr')
  })
})
