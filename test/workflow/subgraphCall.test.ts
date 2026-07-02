import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowDoc } from '../../src/shared/workflow/types'
import { RunContext, NodeRunFailure } from '../../src/main/services/nodes/types'

const mockStore = vi.hoisted(() => ({
  getWorkflowById: vi.fn<(profileId: string, id: string) => WorkflowDoc | null>(() => null)
}))
vi.mock('../../src/main/services/workflowStore', () => mockStore)

import {
  subgraphCall,
  subgraphInput,
  subgraphOutput,
  setBuiltinRegistry
} from '../../src/main/services/nodes/builtin/subgraphNodes'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl } from '../../src/main/services/nodes/types'
// subgraphNodes.ts never imports builtin/index.ts (that's the whole point of the setter design —
// see subgraphNodes.ts's header comment), so subgraph.call has no registry wired until something
// imports index.ts. This side-effect import triggers its setBuiltinRegistry(builtinRegistry) call,
// wiring subgraph.call to the REAL builtin registry — the mocked workflowStore above supplies the
// sub-graph doc, but every node TYPE inside it (subgraph.input/output, control.when, text.template…)
// resolves against the real registry.
import { builtinRegistry } from '../../src/main/services/nodes/builtin'

const subDoc = (overrides: Partial<WorkflowDoc> = {}): WorkflowDoc => ({
  id: 'sub1',
  name: 'Sub',
  version: 1,
  schemaVersion: 1,
  kind: 'subgraph',
  nodes: [
    { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
    { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
  ],
  edges: [{ from: { node: 'bin', port: 'value' }, to: { node: 'bout', port: 'value' } }],
  ...overrides
})

const baseCtx = (overrides: Partial<RunContext> = {}): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {},
  profileId: 'p1',
  ...overrides
})

beforeEach(() => {
  mockStore.getWorkflowById.mockReset().mockReturnValue(null)
})

describe('subgraph.call', () => {
  it('passes a value through a real sub-graph doc (in1 -> out1)', async () => {
    mockStore.getWorkflowById.mockReturnValue(subDoc())
    const res = await subgraphCall.run(baseCtx(), { in1: 'hi' }, {
      id: 'call-1',
      config: { workflow_id: 'sub1' }
    })
    expect(res.outputs?.out1).toBe('hi')
  })

  it('missing doc -> throws NodeRunFailure class B code "bad-subgraph"', async () => {
    mockStore.getWorkflowById.mockReturnValue(null)
    await expect(
      subgraphCall.run(baseCtx(), {}, { id: 'call-1', config: { workflow_id: 'nope' } })
    ).rejects.toMatchObject({ kind: 'B', code: 'bad-subgraph' })
  })

  it('doc with kind "turn" (or absent) -> same class-B "bad-subgraph" failure', async () => {
    mockStore.getWorkflowById.mockReturnValue(subDoc({ kind: 'turn' }))
    await expect(
      subgraphCall.run(baseCtx(), {}, { id: 'call-1', config: { workflow_id: 'sub1' } })
    ).rejects.toMatchObject({ kind: 'B', code: 'bad-subgraph' })
  })

  it('self-reference recursion -> class-B "recursion"', async () => {
    mockStore.getWorkflowById.mockReturnValue(subDoc())
    const ctx = baseCtx({ subgraphStack: ['sub1'] })
    await expect(
      subgraphCall.run(ctx, {}, { id: 'call-1', config: { workflow_id: 'sub1' } })
    ).rejects.toMatchObject({ kind: 'B', code: 'recursion' })
  })

  it('indirect A->B->A recursion -> class-B "recursion" (stack already contains the target id)', async () => {
    mockStore.getWorkflowById.mockReturnValue(subDoc())
    // Simulates being inside B's run, which was invoked from A — A is already on the stack.
    const ctx = baseCtx({ subgraphStack: ['A', 'B'] })
    await expect(
      subgraphCall.run(ctx, {}, { id: 'call-1', config: { workflow_id: 'A' } })
    ).rejects.toMatchObject({ kind: 'B', code: 'recursion' })
  })

  it('depth cap: a stack already at 8 entries refuses one more call', async () => {
    mockStore.getWorkflowById.mockReturnValue(subDoc())
    const ctx = baseCtx({ subgraphStack: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })
    await expect(
      subgraphCall.run(ctx, {}, { id: 'call-1', config: { workflow_id: 'sub1' } })
    ).rejects.toMatchObject({ kind: 'B', code: 'recursion' })
  })

  it('an unwired inner failure surfaces as a wrapper throw carrying the inner kind/message/code (item 5, second half)', async () => {
    // Temporarily swap in a registry with a node that throws a NodeRunFailure, unwired inside
    // the sub-graph — exercises subgraph.call's exact `result.fatal` -> re-throw relay, not just
    // runSubgraph's own return value (already covered in subgraph.test.ts).
    const boom: NodeImpl = {
      type: 'test.boom',
      title: 'boom',
      inputs: [],
      outputs: [{ name: 'out', type: 'Any' }],
      run: () => {
        throw new NodeRunFailure('B', 'inner validator gave up', 3, 'validator')
      }
    }
    const testRegistry = createRegistry([subgraphInput, subgraphOutput, boom])
    setBuiltinRegistry(testRegistry)
    try {
      mockStore.getWorkflowById.mockReturnValue(
        subDoc({
          nodes: [
            { id: 'b', type: 'test.boom' },
            { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
          ],
          edges: [{ from: { node: 'b', port: 'out' }, to: { node: 'bout', port: 'value' } }]
        })
      )
      await expect(
        subgraphCall.run(baseCtx(), {}, { id: 'call-1', config: { workflow_id: 'sub1' } })
      ).rejects.toMatchObject({
        kind: 'B',
        code: 'validator',
        attempts: 3,
        message: 'inner validator gave up'
      })
    } finally {
      // Restore the real registry so every other test in this file (and any test file that
      // imports builtin/index.ts after this one runs) sees the normal builtin node set again.
      setBuiltinRegistry(builtinRegistry)
    }
  })

  it('promotions: params land on the promoted node config key; unknown promotion nodeId is skipped without throwing', async () => {
    const doc = subDoc({
      nodes: [
        { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
        { id: 'tpl', type: 'text.template', config: { template: 'default' } },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      edges: [{ from: { node: 'tpl', port: 'text' }, to: { node: 'bout', port: 'value' } }],
      meta: {
        promotions: [
          { name: 'greeting', nodeId: 'tpl', configKey: 'template', label: 'Greeting' },
          { name: 'ghost', nodeId: 'does-not-exist', configKey: 'x' }
        ]
      }
    })
    mockStore.getWorkflowById.mockReturnValue(doc)
    const res = await subgraphCall.run(baseCtx(), {}, {
      id: 'call-1',
      config: { workflow_id: 'sub1', params: { greeting: 'hello world' } }
    })
    expect(res.outputs?.out1).toBe('hello world')

    // Original stored doc's node config is untouched (promotions clone, never mutate the source).
    expect((doc.nodes[1].config as any).template).toBe('default')
  })

  it('node-state prefixing: inner getNodeState reaches the parent as "<wrapperId>/<innerId>"', async () => {
    const doc = subDoc({
      nodes: [
        { id: 'gate', type: 'control.when', config: { op: 'changed' } },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      edges: []
    })
    mockStore.getWorkflowById.mockReturnValue(doc)
    const getSpy = vi.fn(() => undefined)
    const setSpy = vi.fn()
    await subgraphCall.run(baseCtx({ getNodeState: getSpy, setNodeState: setSpy }), {}, {
      id: 'call-1',
      config: { workflow_id: 'sub1' }
    })
    expect(setSpy).toHaveBeenCalledWith('call-1/gate', expect.anything())
  })

  it('two subgraph.call instances of the SAME sub-graph get distinct state keys', async () => {
    const doc = subDoc({
      nodes: [
        { id: 'gate', type: 'control.when', config: { op: 'changed' } },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      edges: []
    })
    mockStore.getWorkflowById.mockReturnValue(doc)
    const setSpy = vi.fn()
    const ctx = baseCtx({ setNodeState: setSpy })
    await subgraphCall.run(ctx, {}, { id: 'call-1', config: { workflow_id: 'sub1' } })
    await subgraphCall.run(ctx, {}, { id: 'call-2', config: { workflow_id: 'sub1' } })
    const keys = setSpy.mock.calls.map((c) => c[0])
    expect(keys).toContain('call-1/gate')
    expect(keys).toContain('call-2/gate')
    expect(new Set(keys).size).toBe(keys.length)
  })
})
