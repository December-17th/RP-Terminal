import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const order: string[] = []
const impls: NodeImpl[] = [
  {
    type: 'pre',
    title: 'pre',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => {
      order.push('pre-node')
      return { outputs: { out: 'x' } }
    }
  },
  {
    type: 'main',
    title: 'main',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    isMainOutputCapable: true,
    run: () => {
      order.push('main')
      return { outputs: { out: 'reply' } }
    }
  },
  {
    type: 'post',
    title: 'post',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [],
    run: () => {
      order.push('post-node')
      return {}
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

describe('runWorkflow — phases', () => {
  it('runs pre nodes, fires onResponseReady, then post nodes', async () => {
    order.length = 0
    const events: string[] = []
    const ctx: RunContext = {
      signal: new AbortController().signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {},
      onResponseReady: () => events.push('ready')
    }
    // pre -> main (main output); main -> post (post phase, downstream of main output)
    const d = doc(
      [
        { id: 'p', type: 'pre' },
        { id: 'm', type: 'main', isMainOutput: true },
        { id: 'q', type: 'post' }
      ],
      [
        { from: { node: 'p', port: 'out' }, to: { node: 'm', port: 'in' } },
        { from: { node: 'm', port: 'out' }, to: { node: 'q', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx)
    expect(res.ok).toBe(true)
    // ordering: pre-node, main, ready, post-node
    expect([...order.slice(0, 2), 'ready', order[2]]).toEqual([
      'pre-node',
      'main',
      'ready',
      'post-node'
    ])
    expect(res.traces.find((t) => t.nodeId === 'p')?.phase).toBe('pre')
    expect(res.traces.find((t) => t.nodeId === 'm')?.phase).toBe('pre')
    expect(res.traces.find((t) => t.nodeId === 'q')?.phase).toBe('post')
  })

  it('hands the outputs-so-far (main node included) to onResponseReady, before post runs', async () => {
    order.length = 0
    let readyOutputs: Map<string, Record<string, unknown>> | undefined
    let postHadRun = false
    const ctx: RunContext = {
      signal: new AbortController().signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {},
      onResponseReady: (outputs) => {
        readyOutputs = outputs
        postHadRun = order.includes('post-node')
      }
    }
    const d = doc(
      [
        { id: 'p', type: 'pre' },
        { id: 'm', type: 'main', isMainOutput: true },
        { id: 'q', type: 'post' }
      ],
      [
        { from: { node: 'p', port: 'out' }, to: { node: 'm', port: 'in' } },
        { from: { node: 'm', port: 'out' }, to: { node: 'q', port: 'in' } }
      ]
    )
    await runWorkflow(d, reg, ctx)
    expect(postHadRun).toBe(false) // the boundary fires before any post node
    expect(readyOutputs?.get('m')).toBeDefined() // caller can lift the turn result right here
  })

  it('puts an independent side node (no path to main output) in the post phase', async () => {
    order.length = 0
    const ctx: RunContext = {
      signal: new AbortController().signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }
    // `p2` feeds nothing that reaches main; it is background → post phase.
    const d = doc(
      [
        { id: 'm', type: 'main', isMainOutput: true },
        { id: 'p2', type: 'pre' }
      ],
      []
    )
    const res = await runWorkflow(d, reg, ctx)
    expect(res.traces.find((t) => t.nodeId === 'm')?.phase).toBe('pre')
    expect(res.traces.find((t) => t.nodeId === 'p2')?.phase).toBe('post')
  })
})
