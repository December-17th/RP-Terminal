import { describe, it, expect } from 'vitest'
import { summarizeRun, OUTPUT_PREVIEW_MAX, DEBUG_PREVIEW_MAX } from '../../src/shared/workflow/trace'
import { WorkflowDoc, NodeDescriptor } from '../../src/shared/workflow/types'

// Pure trace summary (spec §13): engine RunResult → serializable per-node trace with
// capped output previews; Context ports skipped; errors carried through.

const doc: WorkflowDoc = {
  id: 'wf1',
  name: 'test',
  version: 1,
  schemaVersion: 1,
  nodes: [
    { id: 'ctx', type: 'input.context' },
    { id: 'llm', type: 'llm.sample' },
    { id: 'gate', type: 'control.if' },
    { id: 'side', type: 'text.template' }
  ],
  edges: []
}

const descriptors = new Map<string, NodeDescriptor>([
  [
    'input.context',
    { type: 'input.context', title: 'Context', inputs: [], outputs: [{ name: 'gen', type: 'Context' }] }
  ],
  [
    'llm.sample',
    {
      type: 'llm.sample',
      title: 'Sample',
      inputs: [],
      outputs: [
        { name: 'raw', type: 'Text' },
        { name: 'rawUsage', type: 'Any' }
      ]
    }
  ],
  [
    'control.if',
    { type: 'control.if', title: 'If', inputs: [], outputs: [{ name: 'then', type: 'Signal' }] }
  ],
  [
    'text.template',
    { type: 'text.template', title: 'Template', inputs: [], outputs: [{ name: 'text', type: 'Text' }] }
  ]
])

const meta = { chatId: 'chat1', workflowId: 'wf1', startedAt: 1000, durationMs: 250 }

describe('summarizeRun', () => {
  it('maps statuses, phases, timings and node types; skips Context port previews', () => {
    const trace = summarizeRun(
      doc,
      descriptors,
      {
        ok: true,
        aborted: false,
        traces: [
          { nodeId: 'ctx', status: 'ran', phase: 'pre', ms: 2 },
          { nodeId: 'llm', status: 'ran', phase: 'pre', ms: 900 },
          { nodeId: 'gate', status: 'ran', phase: 'post', ms: 1 },
          { nodeId: 'side', status: 'skipped', phase: 'post' }
        ],
        outputs: new Map([
          ['ctx', { gen: { settings: {}, floors: [] } }],
          ['llm', { raw: 'Hello there.', rawUsage: { input_tokens: 5 } }],
          ['gate', {}]
        ])
      },
      meta
    )

    expect(trace).toMatchObject({ ...meta, ok: true, aborted: false })
    expect(trace.nodes).toHaveLength(4)

    const ctx = trace.nodes[0]
    expect(ctx.nodeType).toBe('input.context')
    expect(ctx.outputs).toBeUndefined() // Context port skipped → nothing left to preview

    const llm = trace.nodes[1]
    expect(llm.status).toBe('ran')
    expect(llm.ms).toBe(900)
    expect(llm.outputs).toEqual({ raw: 'Hello there.', rawUsage: '{"input_tokens":5}' })

    const side = trace.nodes[3]
    expect(side.status).toBe('skipped')
    expect(side.ms).toBeUndefined()
    expect(side.outputs).toBeUndefined()
  })

  it('caps long output previews', () => {
    const long = 'x'.repeat(OUTPUT_PREVIEW_MAX + 100)
    const trace = summarizeRun(
      doc,
      descriptors,
      {
        ok: true,
        aborted: false,
        traces: [{ nodeId: 'llm', status: 'ran', phase: 'pre', ms: 1 }],
        outputs: new Map([['llm', { raw: long }]])
      },
      meta
    )
    const p = trace.nodes[0].outputs!.raw
    expect(p.length).toBe(OUTPUT_PREVIEW_MAX + 1) // + the ellipsis
    expect(p.endsWith('…')).toBe(true)
  })

  it('carries node errors and the fatal run error', () => {
    const trace = summarizeRun(
      doc,
      descriptors,
      {
        ok: false,
        aborted: false,
        traces: [
          {
            nodeId: 'llm',
            status: 'failed',
            phase: 'pre',
            ms: 30,
            error: { kind: 'A', message: 'API Error: 500' }
          }
        ],
        outputs: new Map(),
        error: { message: 'API Error: 500', nodeId: 'llm' }
      },
      meta
    )
    expect(trace.ok).toBe(false)
    expect(trace.error).toEqual({ message: 'API Error: 500', nodeId: 'llm' })
    expect(trace.nodes[0].error).toEqual({ kind: 'A', message: 'API Error: 500' })
    expect(trace.nodes[0].outputs).toBeUndefined() // failed nodes get no previews
  })

  it('survives unserializable output values', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const trace = summarizeRun(
      doc,
      descriptors,
      {
        ok: true,
        aborted: false,
        traces: [{ nodeId: 'side', status: 'ran', phase: 'post', ms: 1 }],
        outputs: new Map([['side', { text: circular }]])
      },
      meta
    )
    expect(trace.nodes[0].outputs).toEqual({ text: '(unserializable)' })
  })

  it('folds NodeResult.debug into a ran node\'s previews, alongside port outputs', () => {
    const trace = summarizeRun(
      doc,
      descriptors,
      {
        ok: true,
        aborted: false,
        traces: [{ nodeId: 'llm', status: 'ran', phase: 'pre', ms: 1 }],
        outputs: new Map([['llm', { raw: 'reply' }]]),
        debug: new Map([['llm', { 'prompt (sent)': '[system]\nyou are…' }]])
      },
      meta
    )
    // Both the port output AND the debug entry appear as labeled previews in the Runs tab.
    expect(trace.nodes[0].outputs).toEqual({ raw: 'reply', 'prompt (sent)': '[system]\nyou are…' })
  })

  it('caps debug previews at DEBUG_PREVIEW_MAX (roomier than port previews)', () => {
    const long = 'y'.repeat(DEBUG_PREVIEW_MAX + 100)
    const trace = summarizeRun(
      doc,
      descriptors,
      {
        ok: true,
        aborted: false,
        traces: [{ nodeId: 'llm', status: 'ran', phase: 'pre', ms: 1 }],
        outputs: new Map(),
        debug: new Map([['llm', { 'prompt (sent)': long }]])
      },
      meta
    )
    const p = trace.nodes[0].outputs!['prompt (sent)']
    expect(DEBUG_PREVIEW_MAX).toBeGreaterThan(OUTPUT_PREVIEW_MAX)
    expect(p.length).toBe(DEBUG_PREVIEW_MAX + 1) // + the ellipsis
    expect(p.endsWith('…')).toBe(true)
  })

  it('ignores debug for a node that did not run (no previews on skipped/failed)', () => {
    const trace = summarizeRun(
      doc,
      descriptors,
      {
        ok: true,
        aborted: false,
        traces: [{ nodeId: 'side', status: 'skipped', phase: 'post' }],
        outputs: new Map(),
        debug: new Map([['side', { 'prompt (sent)': 'never sent' }]])
      },
      meta
    )
    expect(trace.nodes[0].outputs).toBeUndefined()
  })

  it('labels nodes missing from the doc as unknown (defensive)', () => {
    const trace = summarizeRun(
      doc,
      descriptors,
      {
        ok: true,
        aborted: true,
        traces: [{ nodeId: 'ghost', status: 'skipped', phase: 'post' }],
        outputs: new Map()
      },
      meta
    )
    expect(trace.aborted).toBe(true)
    expect(trace.nodes[0].nodeType).toBe('unknown')
  })
})
