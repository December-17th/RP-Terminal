import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'
import { llmSample } from '../../src/main/services/nodes/builtin/generationNodes'

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

// `gate` fires per config.fire; `job` has a data input AND a when Signal input.
const impls: NodeImpl[] = [
  {
    type: 'src',
    title: 'src',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'data' } })
  },
  {
    type: 'gate',
    title: 'gate',
    inputs: [],
    outputs: [{ name: 'fire', type: 'Signal' }],
    run: (_c, _i, node) => ({ signals: node.config.fire ? ['fire'] : [] })
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
    type: 'sink',
    title: 'sink',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [],
    isMainOutputCapable: true,
    run: () => ({})
  }
]
const reg = createRegistry(impls)

const graph = (fire: boolean): WorkflowDoc =>
  doc(
    [
      { id: 's', type: 'src' },
      { id: 'g', type: 'gate', config: { fire } },
      { id: 'j', type: 'job' },
      { id: 'k', type: 'sink', isMainOutput: true }
    ],
    [
      { from: { node: 's', port: 'out' }, to: { node: 'j', port: 'in' } },
      { from: { node: 'g', port: 'fire' }, to: { node: 'j', port: 'when' } },
      { from: { node: 's', port: 'out' }, to: { node: 'k', port: 'in' } }
    ]
  )

describe('runWorkflow — Signal gating (spec §5)', () => {
  it('skips a node whose when-Signal did not fire, even with a live data edge', async () => {
    const res = await runWorkflow(graph(false), reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('skipped')
  })

  it('runs the node when the gating Signal fired', async () => {
    const res = await runWorkflow(graph(true), reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('ran')
    expect(res.outputs.get('j')).toEqual({ out: 'ran' })
  })
})

describe('llm.sample gating port', () => {
  it('declares an optional when: Signal input (unwired in the default graph)', () => {
    expect(llmSample.inputs).toContainEqual({ name: 'when', type: 'Signal' })
  })
})
