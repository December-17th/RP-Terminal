import { describe, it, expect } from 'vitest'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { WorkflowDoc, NodeDescriptor, NodeInstance, Edge } from '../../src/shared/workflow/types'
import { CHECKPOINTS } from '../../src/shared/workflow/checkpoints'
import { AttachmentDecl } from '../../src/shared/workflow/attachments'

// Descriptors: a Text producer and a Context producer, so inline entries can be exercised against
// checkpoints of different value types (prompt-assembly = Text, context-ready = Context).
const descriptors = new Map<string, NodeDescriptor>([
  ['textNode', { type: 'textNode', title: 'Text', inputs: [], outputs: [{ name: 'out', type: 'Text' }] }],
  ['ctxNode', { type: 'ctxNode', title: 'Ctx', inputs: [], outputs: [{ name: 'out', type: 'Context' }] }],
  [
    'sink',
    {
      type: 'sink',
      title: 'Sink',
      inputs: [{ name: 'in', type: 'Text' }],
      outputs: [],
      isMainOutputCapable: true
    }
  ]
])

const doc = (
  nodes: NodeInstance[],
  edges: Edge[],
  extra: Partial<WorkflowDoc> = {}
): WorkflowDoc => ({
  id: 'f',
  name: 'f',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges,
  ...extra
})

/** A fragment doc with the given attachments and one Text-producing node (no main-output). */
const fragment = (attachments: AttachmentDecl[]): WorkflowDoc =>
  doc([{ id: 'a', type: 'textNode' }], [], { kind: 'fragment', attachments })

const codes = (r: ReturnType<typeof validateWorkflow>): string[] =>
  r.ok ? [] : r.errors.map((e) => e.code)

describe('validateWorkflow — fragment docs (agent-packs plan WP1.1; ADR 0002/0009)', () => {
  it('accepts a valid branch fragment (single branch entry)', () => {
    const r = validateWorkflow(
      fragment([{ kind: 'entry', checkpoint: 'context-ready', mode: 'branch' }]),
      descriptors
    )
    expect(r).toEqual({ ok: true })
  })

  it('accepts a valid inline fragment producing a type-compatible value', () => {
    // prompt-assembly's value type is Text; the fragment's textNode produces Text.
    expect(CHECKPOINTS['prompt-assembly'].valueType).toBe('Text')
    const r = validateWorkflow(
      fragment([{ kind: 'entry', checkpoint: 'prompt-assembly', mode: 'inline' }]),
      descriptors
    )
    expect(r).toEqual({ ok: true })
  })

  it('accepts a valid multi-attachment fragment (entry + rejoin + trigger stub)', () => {
    const r = validateWorkflow(
      fragment([
        { kind: 'entry', checkpoint: 'context-ready', mode: 'branch' },
        { kind: 'rejoin', checkpoint: 'prompt-assembly' },
        { kind: 'trigger' }
      ]),
      descriptors
    )
    expect(r).toEqual({ ok: true })
  })

  it('rejects a fragment with zero attachments (NO_ATTACHMENT)', () => {
    const r = validateWorkflow(fragment([]), descriptors)
    expect(codes(r)).toContain('NO_ATTACHMENT')
  })

  it('rejects an attachment naming an unknown checkpoint (UNKNOWN_CHECKPOINT)', () => {
    const r = validateWorkflow(
      // Cast: CheckpointId is a closed union, but a hand-authored/imported doc can carry a bad name.
      fragment([{ kind: 'entry', checkpoint: 'not-a-checkpoint', mode: 'branch' } as unknown as AttachmentDecl]),
      descriptors
    )
    expect(codes(r)).toContain('UNKNOWN_CHECKPOINT')
  })

  it('rejects an inline entry with no type-compatible output (INLINE_TYPE)', () => {
    // context-ready wants Context, but this fragment produces only Text.
    expect(CHECKPOINTS['context-ready'].valueType).toBe('Context')
    const r = validateWorkflow(
      fragment([{ kind: 'entry', checkpoint: 'context-ready', mode: 'inline' }]),
      descriptors
    )
    expect(codes(r)).toContain('INLINE_TYPE')
  })

  it('an inline entry with a matching output type passes (Context producer at context-ready)', () => {
    const d = doc([{ id: 'c', type: 'ctxNode' }], [], {
      kind: 'fragment',
      attachments: [{ kind: 'entry', checkpoint: 'context-ready', mode: 'inline' }]
    })
    expect(validateWorkflow(d, descriptors)).toEqual({ ok: true })
  })

  it('accepts a rejoin selecting a known anchor lane (prompt-assembly `entries` — WP1.6b)', () => {
    const r = validateWorkflow(
      fragment([{ kind: 'rejoin', checkpoint: 'prompt-assembly', anchor: 'entries' }]),
      descriptors
    )
    expect(r).toEqual({ ok: true })
  })

  it('rejects a rejoin selecting an unknown anchor lane (UNKNOWN_ANCHOR — WP1.6b)', () => {
    const r = validateWorkflow(
      fragment([{ kind: 'rejoin', checkpoint: 'prompt-assembly', anchor: 'not-a-lane' }]),
      descriptors
    )
    expect(codes(r)).toContain('UNKNOWN_ANCHOR')
  })

  it('rejects a selector naming another checkpoint\'s lane (context-ready has no `entries` lane)', () => {
    const r = validateWorkflow(
      fragment([{ kind: 'rejoin', checkpoint: 'context-ready', anchor: 'entries' }]),
      descriptors
    )
    expect(codes(r)).toContain('UNKNOWN_ANCHOR')
  })

  it('a fragment skips the exactly-one-main-output rule (like a subgraph)', () => {
    // No isMainOutput node anywhere, yet no MAIN_OUTPUT error for a fragment.
    const r = validateWorkflow(
      fragment([{ kind: 'entry', checkpoint: 'context-ready', mode: 'branch' }]),
      descriptors
    )
    expect(codes(r)).not.toContain('MAIN_OUTPUT')
  })
})

describe('validateWorkflow — turn/subgraph unaffected by fragment support', () => {
  const good = (): WorkflowDoc =>
    doc(
      [
        { id: 'a', type: 'textNode' },
        { id: 'b', type: 'sink', isMainOutput: true }
      ],
      [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }]
    )

  it('a turn doc validates exactly as before (still requires one main-output)', () => {
    // Well-formed turn: ok.
    expect(validateWorkflow(good(), descriptors)).toEqual({ ok: true })
    // Turn with no main-output: still MAIN_OUTPUT, no fragment codes leaking in.
    const noMain = good()
    noMain.nodes[1].isMainOutput = false
    const r = validateWorkflow(noMain, descriptors)
    expect(codes(r)).toContain('MAIN_OUTPUT')
    expect(codes(r)).not.toContain('NO_ATTACHMENT')
  })

  it('a subgraph doc validates exactly as before (skips main-output, no attachment rules)', () => {
    // A subgraph with no main-output and no attachments must still be ok — the fragment-only
    // NO_ATTACHMENT rule must not fire for it.
    const sub = doc([{ id: 'a', type: 'textNode' }], [], { kind: 'subgraph' })
    const r = validateWorkflow(sub, descriptors)
    expect(r).toEqual({ ok: true })
  })
})
