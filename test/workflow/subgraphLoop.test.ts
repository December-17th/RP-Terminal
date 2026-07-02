import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowDoc } from '../../src/shared/workflow/types'
import { RunContext, NodeImpl, NodeRunFailure } from '../../src/main/services/nodes/types'

const mockStore = vi.hoisted(() => ({
  getWorkflowById: vi.fn<(profileId: string, id: string) => WorkflowDoc | null>(() => null)
}))
vi.mock('../../src/main/services/workflowStore', () => mockStore)

import {
  subgraphLoop,
  subgraphInput,
  subgraphOutput,
  setBuiltinRegistry
} from '../../src/main/services/nodes/builtin/subgraphNodes'
import { createRegistry } from '../../src/main/services/nodes/registry'
// Side-effect import wires the REAL builtin registry into subgraphNodes via setBuiltinRegistry —
// see subgraphCall.test.ts's note. Node TYPES inside a sub-graph doc (subgraph.input/output,
// text.template…) resolve against this real registry; the mocked store just supplies the doc.
import { builtinRegistry } from '../../src/main/services/nodes/builtin'

/** A sub-graph that maps in1 -> out1 through a real text.template (`{{in1}}!`). */
const appendBangDoc = (): WorkflowDoc => ({
  id: 'sub1',
  name: 'AppendBang',
  version: 1,
  schemaVersion: 1,
  kind: 'subgraph',
  nodes: [
    { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
    { id: 'tpl', type: 'text.template', config: { template: '{{in1}}!' } },
    { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
  ],
  edges: [
    { from: { node: 'bin', port: 'value' }, to: { node: 'tpl', port: 'in1' } },
    { from: { node: 'tpl', port: 'text' }, to: { node: 'bout', port: 'value' } }
  ]
})

/** A sub-graph that routes the iteration index (in2 slot) straight to out1. */
const indexDoc = (): WorkflowDoc => ({
  id: 'sub1',
  name: 'Index',
  version: 1,
  schemaVersion: 1,
  kind: 'subgraph',
  nodes: [
    { id: 'bin', type: 'subgraph.input', config: { slot: 'in2' } },
    { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
  ],
  edges: [{ from: { node: 'bin', port: 'value' }, to: { node: 'bout', port: 'value' } }]
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

/** Custom-registry helper for the `until` tests: an "increment" node that adds 1 to its in1
 *  number (out) and reports done (out2) once the value reaches `target`. Mirrors the
 *  subgraphCall.test.ts "unwired inner failure" pattern (swap registry in a try/finally). */
const incNode = (target: number): NodeImpl => ({
  type: 'test.inc',
  title: 'inc',
  inputs: [{ name: 'in', type: 'Any' }],
  outputs: [
    { name: 'out', type: 'Any' },
    { name: 'done', type: 'Any' }
  ],
  run: (_ctx, inputs) => {
    const next = (typeof inputs.in === 'number' ? inputs.in : 0) + 1
    return { outputs: { out: next, done: next >= target } }
  }
})

/** Sub-graph wrapping test.inc: in1 -> inc.out -> out1; inc.done -> out2. */
const incDoc = (): WorkflowDoc => ({
  id: 'sub1',
  name: 'Inc',
  version: 1,
  schemaVersion: 1,
  kind: 'subgraph',
  nodes: [
    { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
    { id: 'inc', type: 'test.inc' },
    { id: 'bo1', type: 'subgraph.output', config: { slot: 'out1' } },
    { id: 'bo2', type: 'subgraph.output', config: { slot: 'out2' } }
  ],
  edges: [
    { from: { node: 'bin', port: 'value' }, to: { node: 'inc', port: 'in' } },
    { from: { node: 'inc', port: 'out' }, to: { node: 'bo1', port: 'value' } },
    { from: { node: 'inc', port: 'done' }, to: { node: 'bo2', port: 'value' } }
  ]
})

beforeEach(() => {
  mockStore.getWorkflowById.mockReset().mockReturnValue(null)
})

describe('subgraph.loop — foreach', () => {
  it('runs the sub-graph once per array element; out1 collects each pass, out2 = count', async () => {
    mockStore.getWorkflowById.mockReturnValue(appendBangDoc())
    const res = await subgraphLoop.run(baseCtx(), { in1: ['a', 'b', 'c'] }, {
      id: 'loop-1',
      config: { workflow_id: 'sub1', mode: 'foreach' }
    })
    expect(res.outputs?.out1).toEqual(['a!', 'b!', 'c!'])
    expect(res.outputs?.out2).toBe(3)
  })

  it('seeds in2 with the pass index (0,1,2…)', async () => {
    mockStore.getWorkflowById.mockReturnValue(indexDoc())
    const res = await subgraphLoop.run(baseCtx(), { in1: ['x', 'y', 'z'] }, {
      id: 'loop-1',
      config: { workflow_id: 'sub1', mode: 'foreach' }
    })
    expect(res.outputs?.out1).toEqual([0, 1, 2])
  })

  it('null/undefined in1 → zero passes, out1 [], out2 0', async () => {
    mockStore.getWorkflowById.mockReturnValue(appendBangDoc())
    const resNull = await subgraphLoop.run(baseCtx(), { in1: null }, {
      id: 'loop-1',
      config: { workflow_id: 'sub1' }
    })
    expect(resNull.outputs?.out1).toEqual([])
    expect(resNull.outputs?.out2).toBe(0)

    const resUndef = await subgraphLoop.run(baseCtx(), {}, {
      id: 'loop-1',
      config: { workflow_id: 'sub1' }
    })
    expect(resUndef.outputs?.out1).toEqual([])
    expect(resUndef.outputs?.out2).toBe(0)
  })

  it('non-array in1 → class-B NodeRunFailure code "bad-loop-input"', async () => {
    mockStore.getWorkflowById.mockReturnValue(appendBangDoc())
    await expect(
      subgraphLoop.run(baseCtx(), { in1: 'not an array' }, {
        id: 'loop-1',
        config: { workflow_id: 'sub1' }
      })
    ).rejects.toMatchObject({ kind: 'B', code: 'bad-loop-input' })
  })

  it('truncates to max_iterations: 5 items with max_iterations 3 → 3 passes', async () => {
    mockStore.getWorkflowById.mockReturnValue(appendBangDoc())
    const res = await subgraphLoop.run(baseCtx(), { in1: ['a', 'b', 'c', 'd', 'e'] }, {
      id: 'loop-1',
      config: { workflow_id: 'sub1', mode: 'foreach', max_iterations: 3 }
    })
    expect(res.outputs?.out1).toEqual(['a!', 'b!', 'c!'])
    expect(res.outputs?.out2).toBe(3)
  })
})

describe('subgraph.loop — until', () => {
  it('feeds out1 back as in1 and stops when a pass reports truthy out2', async () => {
    const registry = createRegistry([subgraphInput, subgraphOutput, incNode(3)])
    setBuiltinRegistry(registry)
    try {
      mockStore.getWorkflowById.mockReturnValue(incDoc())
      const res = await subgraphLoop.run(baseCtx(), { in1: 0 }, {
        id: 'loop-1',
        config: { workflow_id: 'sub1', mode: 'until' }
      })
      // 0→1, 1→2, 2→3 (done) — three passes, final carry 3.
      expect(res.outputs?.out1).toBe(3)
      expect(res.outputs?.out2).toBe(3)
    } finally {
      setBuiltinRegistry(builtinRegistry)
    }
  })

  it('never-done body stops at max_iterations (default 10 when unset)', async () => {
    // target far above the default cap so out2 never becomes truthy.
    const registry = createRegistry([subgraphInput, subgraphOutput, incNode(1000)])
    setBuiltinRegistry(registry)
    try {
      mockStore.getWorkflowById.mockReturnValue(incDoc())
      const resDefault = await subgraphLoop.run(baseCtx(), { in1: 0 }, {
        id: 'loop-1',
        config: { workflow_id: 'sub1', mode: 'until' }
      })
      expect(resDefault.outputs?.out2).toBe(10)
      expect(resDefault.outputs?.out1).toBe(10)

      const resCapped = await subgraphLoop.run(baseCtx(), { in1: 0 }, {
        id: 'loop-1',
        config: { workflow_id: 'sub1', mode: 'until', max_iterations: 4 }
      })
      expect(resCapped.outputs?.out2).toBe(4)
      expect(resCapped.outputs?.out1).toBe(4)
    } finally {
      setBuiltinRegistry(builtinRegistry)
    }
  })
})

describe('subgraph.loop — guards, failures, state', () => {
  it('recursion guard: target already on the stack → class-B "recursion"', async () => {
    mockStore.getWorkflowById.mockReturnValue(appendBangDoc())
    const ctx = baseCtx({ subgraphStack: ['sub1'] })
    await expect(
      subgraphLoop.run(ctx, { in1: ['a'] }, { id: 'loop-1', config: { workflow_id: 'sub1' } })
    ).rejects.toMatchObject({ kind: 'B', code: 'recursion' })
  })

  it('an inner fatal surfaces as a wrapper throw with "iteration N:" prefix and inner code', async () => {
    const boom: NodeImpl = {
      type: 'test.boom',
      title: 'boom',
      inputs: [{ name: 'in', type: 'Any' }],
      outputs: [{ name: 'out', type: 'Any' }],
      run: () => {
        throw new NodeRunFailure('B', 'inner validator gave up', 3, 'validator')
      }
    }
    const registry = createRegistry([subgraphInput, subgraphOutput, boom])
    setBuiltinRegistry(registry)
    try {
      mockStore.getWorkflowById.mockReturnValue({
        id: 'sub1',
        name: 'Boom',
        version: 1,
        schemaVersion: 1,
        kind: 'subgraph',
        nodes: [
          { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
          { id: 'b', type: 'test.boom' },
          { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
        ],
        edges: [
          { from: { node: 'bin', port: 'value' }, to: { node: 'b', port: 'in' } },
          { from: { node: 'b', port: 'out' }, to: { node: 'bout', port: 'value' } }
        ]
      })
      await expect(
        subgraphLoop.run(baseCtx(), { in1: ['a', 'b'] }, {
          id: 'loop-1',
          config: { workflow_id: 'sub1', mode: 'foreach' }
        })
      ).rejects.toMatchObject({
        kind: 'B',
        code: 'validator',
        attempts: 3,
        message: 'iteration 0: inner validator gave up'
      })
    } finally {
      setBuiltinRegistry(builtinRegistry)
    }
  })

  it('node-state prefixing: inner setNodeState reaches the parent as "<wrapperId>/<innerId>"', async () => {
    mockStore.getWorkflowById.mockReturnValue({
      id: 'sub1',
      name: 'Gate',
      version: 1,
      schemaVersion: 1,
      kind: 'subgraph',
      nodes: [
        { id: 'gate', type: 'control.when', config: { op: 'changed' } },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      edges: []
    })
    const setSpy = vi.fn()
    await subgraphLoop.run(baseCtx({ setNodeState: setSpy }), { in1: ['a'] }, {
      id: 'loop-1',
      config: { workflow_id: 'sub1', mode: 'foreach' }
    })
    const keys = setSpy.mock.calls.map((c) => c[0])
    expect(keys).toContain('loop-1/gate')
  })

  it('an aborted signal before a pass returns empty outputs immediately', async () => {
    mockStore.getWorkflowById.mockReturnValue(appendBangDoc())
    const ac = new AbortController()
    ac.abort()
    const res = await subgraphLoop.run(baseCtx({ signal: ac.signal }), { in1: ['a', 'b'] }, {
      id: 'loop-1',
      config: { workflow_id: 'sub1', mode: 'foreach' }
    })
    expect(res.outputs).toEqual({})
  })
})
