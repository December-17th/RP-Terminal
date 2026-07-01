import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, NodeMeta, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

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

const seen: NodeMeta[] = []

const echoMeta: NodeImpl = {
  type: 'echoMeta',
  title: 'echoMeta',
  inputs: [],
  outputs: [],
  isMainOutputCapable: true,
  run: (_ctx, _inputs, node) => {
    seen.push(node)
    return {}
  }
}

const needsNumber: NodeImpl = {
  type: 'needsNumber',
  title: 'needsNumber',
  inputs: [],
  outputs: [],
  isMainOutputCapable: true,
  configSchema: z.object({ n: z.number().default(7) }),
  run: (_ctx, _inputs, node) => {
    seen.push(node)
    return {}
  }
}

const reg = createRegistry([echoMeta, needsNumber])

describe('runWorkflow — node meta + config', () => {
  beforeEach(() => {
    seen.length = 0
  })

  it('passes the node id and raw config to run() when no schema is declared', async () => {
    const d = doc([{ id: 'e1', type: 'echoMeta', config: { a: 1 }, isMainOutput: true }], [])
    await runWorkflow(d, reg, ctx())
    expect(seen).toEqual([{ id: 'e1', config: { a: 1 } }])
  })

  it('defaults config to {} when the instance has none', async () => {
    const d = doc([{ id: 'e1', type: 'echoMeta', isMainOutput: true }], [])
    await runWorkflow(d, reg, ctx())
    expect(seen).toEqual([{ id: 'e1', config: {} }])
  })

  it('parses config through configSchema (applying defaults)', async () => {
    const d = doc([{ id: 'n1', type: 'needsNumber', config: {}, isMainOutput: true }], [])
    await runWorkflow(d, reg, ctx())
    expect(seen).toEqual([{ id: 'n1', config: { n: 7 } }])
  })

  it('an invalid config fails the node (pre-phase fatal), run() never called', async () => {
    const d = doc(
      [{ id: 'n1', type: 'needsNumber', config: { n: 'not a number' }, isMainOutput: true }],
      []
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(seen).toEqual([])
    expect(res.ok).toBe(false)
    expect(res.error?.nodeId).toBe('n1')
    expect(res.traces.find((t) => t.nodeId === 'n1')?.status).toBe('failed')
  })
})
