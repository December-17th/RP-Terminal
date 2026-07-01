import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const impls: NodeImpl[] = [
  {
    type: 'aborter',
    title: 'aborter',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    // aborts the run from inside the first node
    run: (ctx) => {
      ;(ctx as { _ac: AbortController })._ac.abort()
      return { outputs: { out: 'x' } }
    }
  },
  {
    type: 'main',
    title: 'main',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    isMainOutputCapable: true,
    run: () => ({ outputs: { out: 'reply' } })
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

describe('runWorkflow — cancellation', () => {
  it('stops the run and marks remaining nodes skipped when aborted mid-run', async () => {
    const ac = new AbortController()
    let readyFired = false
    const ctx = {
      signal: ac.signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {},
      onResponseReady: () => {
        readyFired = true
      },
      _ac: ac
    } as unknown as RunContext
    const d = doc(
      [
        { id: 'a', type: 'aborter' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [{ from: { node: 'a', port: 'out' }, to: { node: 'm', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx)
    expect(res.aborted).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('skipped')
    expect(readyFired).toBe(false)
  })

  it('does not run at all when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx: RunContext = {
      signal: ac.signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }
    const d = doc([{ id: 'm', type: 'main', isMainOutput: true }], [])
    const res = await runWorkflow(d, reg, ctx)
    expect(res.aborted).toBe(true)
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('skipped')
  })
})
