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
