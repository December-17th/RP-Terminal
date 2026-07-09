import { describe, it, expect } from 'vitest'
import {
  composeEffectiveGraph,
  findCheckpointAnchors,
  packNodeId,
  ComposeFragment,
  CompositionMeta
} from '../../src/shared/workflow/compose'
import { WorkflowDoc } from '../../src/shared/workflow/types'
import { AttachmentDecl } from '../../src/shared/workflow/attachments'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { NARRATOR_SPINE_DOC as DEFAULT_GRAPH } from '../fixtures/narratorSpineDoc'

// Golden tests compose against the narrator spine fixture (NARRATOR_SPINE_DOC, aliased DEFAULT_GRAPH) —
// the exact node graph the deleted builtin carried, kept under test/fixtures so the golden stays
// anchored to a stable, plain narrator doc.

/** A fresh clone of the narrator each test so mutations never leak between cases. */
const narrator = (): WorkflowDoc => structuredClone(DEFAULT_GRAPH)

/** A minimal fragment doc with the given nodes/edges/attachments (kind:'fragment'). Node/port
 *  descriptors used here (text.static / prompt.assemble etc.) exist in the builtin registry so the
 *  composed doc validates against it. */
const fragmentDoc = (
  nodes: WorkflowDoc['nodes'],
  edges: WorkflowDoc['edges'],
  attachments: AttachmentDecl[]
): WorkflowDoc => ({
  id: 'frag',
  name: 'frag',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes,
  edges,
  attachments
})

const frag = (doc: WorkflowDoc, over: Partial<ComposeFragment> = {}): ComposeFragment => ({
  packId: 'p',
  doc,
  gateOpen: true,
  ...over
})

const composition = (doc: WorkflowDoc): CompositionMeta =>
  (doc.meta as { composition: CompositionMeta }).composition

describe('findCheckpointAnchors', () => {
  it('resolves all four checkpoints on the default narrator by node TYPE', () => {
    const { anchors, missing } = findCheckpointAnchors(narrator())
    expect(missing).toEqual([])
    expect(anchors['context-ready']).toEqual({ nodeId: 'ctx', port: 'gen' })
    expect(anchors['prompt-assembly']).toEqual({ nodeId: 'assemble', port: 'block' })
    expect(anchors['reply-parsed']).toEqual({ nodeId: 'parse', port: 'parsed' })
    expect(anchors['turn-committed']).toEqual({ nodeId: 'write', port: 'floor' })
  })

  it('matches by TYPE not id (a renamed spine node still resolves)', () => {
    const n = narrator()
    const ctx = n.nodes.find((x) => x.type === 'input.context')!
    ctx.id = 'my-context'
    // repoint edges from ctx
    for (const e of n.edges) if (e.from.node === 'ctx') e.from.node = 'my-context'
    const { anchors } = findCheckpointAnchors(n)
    expect(anchors['context-ready']).toEqual({ nodeId: 'my-context', port: 'gen' })
  })

  it('reports a checkpoint MISSING when its anchor node is absent', () => {
    const n = narrator()
    n.nodes = n.nodes.filter((x) => x.type !== 'parse.response')
    n.edges = n.edges.filter((e) => e.from.node !== 'parse' && e.to.node !== 'parse')
    const { anchors, missing } = findCheckpointAnchors(n)
    expect(missing).toContain('reply-parsed')
    expect(anchors['reply-parsed']).toBeUndefined()
  })

  it('reports a checkpoint MISSING (ambiguous) when two nodes share the anchor type', () => {
    const n = narrator()
    n.nodes.push({ id: 'ctx2', type: 'input.context' })
    const { missing } = findCheckpointAnchors(n)
    expect(missing).toContain('context-ready')
  })
})

describe('composeEffectiveGraph — identity', () => {
  it('compose(narrator, []) returns the narrator UNCHANGED (id-stable, deep-equal)', () => {
    const n = narrator()
    const before = structuredClone(n)
    const { doc, warnings } = composeEffectiveGraph(n, [])
    expect(doc).toBe(n) // same object
    expect(doc).toEqual(before) // untouched
    expect(warnings).toEqual([])
  })

  it('all fragments gated off → output deep-equals the narrator', () => {
    const n = narrator()
    const before = structuredClone(n)
    const f = frag(
      fragmentDoc(
        [{ id: 'blk', type: 'text.template' }],
        [],
        [{ kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }]
      ),
      { gateOpen: false }
    )
    const { doc } = composeEffectiveGraph(n, [f])
    expect(doc).toEqual(before)
  })
})

describe('composeEffectiveGraph — branch fragment', () => {
  // A branch fragment: reads context at context-ready, produces a Text block, rejoins at
  // prompt-assembly's `block` input. Main flow untouched.
  const branch = (): ComposeFragment =>
    frag(
      fragmentDoc(
        [
          { id: 'in', type: 'text.template' }, // stand-in fragment entry node (Text out)
          { id: 'blk', type: 'text.template' } // producing node for the rejoin
        ],
        // Internal wiring: the entry node feeds the rejoin producer, so `blk` is reachable from the
        // open entry (real branch fragments wire their entry through to their rejoin).
        [{ from: { node: 'in', port: 'text' }, to: { node: 'blk', port: 'in1' } }],
        [
          { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'in', port: 'gen' } },
          { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }
        ]
      )
    )

  it('splices prefixed nodes + entry/rejoin edges and records composition meta', () => {
    const { doc, warnings } = composeEffectiveGraph(narrator(), [branch()])
    expect(warnings).toEqual([])

    // Prefixed nodes present.
    expect(doc.nodes.some((n) => n.id === packNodeId('p', 'in'))).toBe(true)
    expect(doc.nodes.some((n) => n.id === packNodeId('p', 'blk'))).toBe(true)

    // Entry edge: ctx.gen → pack:p:in.template
    expect(
      doc.edges.some(
        (e) =>
          e.from.node === 'ctx' &&
          e.from.port === 'gen' &&
          e.to.node === packNodeId('p', 'in') &&
          e.to.port === 'gen'
      )
    ).toBe(true)

    // Rejoin edge: pack:p:blk.out → assemble.block
    expect(
      doc.edges.some(
        (e) =>
          e.from.node === packNodeId('p', 'blk') &&
          e.from.port === 'text' &&
          e.to.node === 'assemble' &&
          e.to.port === 'block'
      )
    ).toBe(true)

    // Main flow untouched: ctx.gen → assemble.gen still there.
    expect(
      doc.edges.some(
        (e) => e.from.node === 'ctx' && e.from.port === 'gen' && e.to.node === 'assemble' && e.to.port === 'gen'
      )
    ).toBe(true)

    // Composition meta attributes both nodes + the entry to the pack.
    const c = composition(doc)
    expect(c.packs['p'].nodeIds).toEqual([packNodeId('p', 'in'), packNodeId('p', 'blk')])
    expect(c.packs['p'].entries).toEqual([{ checkpoint: 'context-ready', mode: 'branch' }])

    // Branch-only pack → every node fails open ('branch').
    expect(c.packs['p'].nodeModes).toEqual({
      [packNodeId('p', 'in')]: 'branch',
      [packNodeId('p', 'blk')]: 'branch'
    })

    // The spliced rejoin edge is recorded verbatim (WP1.3: treat this input as absent on failure).
    expect(c.packs['p'].rejoinEdges).toEqual([
      {
        from: { node: packNodeId('p', 'blk'), port: 'text' },
        to: { node: 'assemble', port: 'block' },
        checkpoint: 'prompt-assembly'
      }
    ])
  })

  it('the composed doc is a runnable turn doc that passes existing validation', () => {
    const { doc } = composeEffectiveGraph(narrator(), [branch()])
    expect(doc.kind).toBe('turn')
    const r = validateWorkflow(doc, builtinRegistry.descriptors())
    expect(r).toEqual({ ok: true })
  })
})

describe('composeEffectiveGraph — inline fragment', () => {
  it('re-routes the main flow THROUGH the fragment at context-ready', () => {
    // Inline at context-ready: fragment reads ctx.gen, emits a fresh Context on `out`, and every
    // consumer of ctx.gen is repointed onto the fragment output. context.refresh has a Context in
    // (`gen`) and a Context out (`gen`) — a real inline-shaped node.
    const inline = frag(
      fragmentDoc(
        [{ id: 'refresh', type: 'context.refresh' }],
        [],
        [
          {
            kind: 'entry',
            checkpoint: 'context-ready',
            mode: 'inline',
            entryPort: { node: 'refresh', port: 'gen' },
            outPort: { node: 'refresh', port: 'gen' }
          }
        ]
      )
    )
    const { doc, warnings } = composeEffectiveGraph(narrator(), [inline])
    expect(warnings).toEqual([])

    const pfx = packNodeId('p', 'refresh')

    // The one edge that legitimately still reads ctx.gen is the entry edge into the fragment.
    const ctxGenConsumers = doc.edges.filter((e) => e.from.node === 'ctx' && e.from.port === 'gen')
    // exactly one: the entry edge into the fragment.
    expect(ctxGenConsumers).toHaveLength(1)
    expect(ctxGenConsumers[0].to).toEqual({ node: pfx, port: 'gen' })

    // Former ctx.gen consumers (assemble/llm/parse/apply/write .gen) now read the fragment output.
    for (const target of ['assemble', 'llm', 'parse', 'apply', 'write']) {
      expect(
        doc.edges.some(
          (e) => e.from.node === pfx && e.from.port === 'gen' && e.to.node === target && e.to.port === 'gen'
        )
      ).toBe(true)
    }

    const c = composition(doc)
    expect(c.packs['p'].entries).toEqual([{ checkpoint: 'context-ready', mode: 'inline' }])
    // Inline pack → the node is load-bearing ('inline'); no rejoins were spliced.
    expect(c.packs['p'].nodeModes).toEqual({ [pfx]: 'inline' })
    expect(c.packs['p'].rejoinEdges).toEqual([])
    expect(validateWorkflow(doc, builtinRegistry.descriptors())).toEqual({ ok: true })
  })
})

describe('composeEffectiveGraph — nodeModes with mixed entries (WP1.2 follow-up)', () => {
  it("a node shared by an inline and a branch sub-path is 'inline' (load-bearing wins)", () => {
    // refresh: inline entry at context-ready (Context in/out). bIn: branch entry at reply-parsed
    // (parse.parsed is Any → text.template.in1 is Any). shared: downstream of BOTH — refresh.gen →
    // shared.gen AND bIn.text → shared.in1. Reachable from the inline entry ⇒ 'inline', even
    // though a branch entry also reaches it.
    const f = frag(
      fragmentDoc(
        [
          { id: 'refresh', type: 'context.refresh' },
          { id: 'bIn', type: 'text.template' },
          { id: 'shared', type: 'text.template' }
        ],
        [
          { from: { node: 'refresh', port: 'gen' }, to: { node: 'shared', port: 'gen' } },
          { from: { node: 'bIn', port: 'text' }, to: { node: 'shared', port: 'in1' } }
        ],
        [
          {
            kind: 'entry',
            checkpoint: 'context-ready',
            mode: 'inline',
            entryPort: { node: 'refresh', port: 'gen' },
            outPort: { node: 'refresh', port: 'gen' }
          },
          { kind: 'entry', checkpoint: 'reply-parsed', mode: 'branch', entryPort: { node: 'bIn', port: 'in1' } }
        ]
      )
    )
    const { doc, warnings } = composeEffectiveGraph(narrator(), [f])
    expect(warnings).toEqual([])

    const c = composition(doc)
    expect(c.packs['p'].nodeModes).toEqual({
      [packNodeId('p', 'refresh')]: 'inline', // the inline entry itself
      [packNodeId('p', 'shared')]: 'inline', // reachable from the inline entry — load-bearing wins
      [packNodeId('p', 'bIn')]: 'branch' // reachable only from the branch entry
    })
    expect(validateWorkflow(doc, builtinRegistry.descriptors())).toEqual({ ok: true })
  })
})

describe('composeEffectiveGraph — multi-attachment fragment (ADR 0009)', () => {
  it('splices entry + rejoin from ONE node copy and IGNORES the trigger stub', () => {
    const f = frag(
      fragmentDoc(
        [{ id: 'blk', type: 'text.template' }],
        [],
        [
          { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'blk', port: 'gen' } },
          { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } },
          { kind: 'trigger', trigger: 'manual' }
        ]
      )
    )
    const { doc, warnings } = composeEffectiveGraph(narrator(), [f])
    expect(warnings).toEqual([])

    // ONE copy of the node (not duplicated per attachment).
    expect(doc.nodes.filter((n) => n.id === packNodeId('p', 'blk'))).toHaveLength(1)

    const c = composition(doc)
    // Trigger contributes nothing → only the entry appears in entries[].
    expect(c.packs['p'].entries).toEqual([{ checkpoint: 'context-ready', mode: 'branch' }])
    expect(c.packs['p'].nodeIds).toEqual([packNodeId('p', 'blk')])
    expect(validateWorkflow(doc, builtinRegistry.descriptors())).toEqual({ ok: true })
  })
})

describe('composeEffectiveGraph — denial (closedEntryIndexes)', () => {
  it('closing one of two entries splices only nodes reachable from the OPEN entry', () => {
    // Two entry sub-paths: entry A (index 0) seeds nodeA→nodeADown; entry B (index 3) seeds
    // nodeB→nodeBDown. Close entry B → nodeB/nodeBDown must NOT be spliced.
    const f = frag(
      fragmentDoc(
        [
          { id: 'aIn', type: 'text.template' },
          { id: 'aOut', type: 'text.template' },
          { id: 'bIn', type: 'text.template' },
          { id: 'bOut', type: 'text.template' }
        ],
        [
          { from: { node: 'aIn', port: 'text' }, to: { node: 'aOut', port: 'in1' } },
          { from: { node: 'bIn', port: 'text' }, to: { node: 'bOut', port: 'in1' } }
        ],
        [
          { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'aIn', port: 'gen' } },
          { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'aOut', port: 'text' } },
          { kind: 'trigger', trigger: 'manual' },
          { kind: 'entry', checkpoint: 'reply-parsed', mode: 'branch', entryPort: { node: 'bIn', port: 'gen' } }
        ]
      ),
      { closedEntryIndexes: [3] }
    )
    const { doc } = composeEffectiveGraph(narrator(), [f])

    const has = (id: string) => doc.nodes.some((n) => n.id === packNodeId('p', id))
    expect(has('aIn')).toBe(true)
    expect(has('aOut')).toBe(true)
    // Reachable only through the closed entry B → dropped.
    expect(has('bIn')).toBe(false)
    expect(has('bOut')).toBe(false)

    const c = composition(doc)
    expect(c.packs['p'].entries).toEqual([{ checkpoint: 'context-ready', mode: 'branch' }])
    expect(validateWorkflow(doc, builtinRegistry.descriptors())).toEqual({ ok: true })
  })
})

describe('composeEffectiveGraph — missing checkpoint (ADR 0002)', () => {
  it('skips an attachment naming a checkpoint the narrator lacks, warns, composes the rest', () => {
    // Strip parse.response from the narrator → reply-parsed is missing.
    const n = narrator()
    n.nodes = n.nodes.filter((x) => x.type !== 'parse.response')
    n.edges = n.edges.filter((e) => e.from.node !== 'parse' && e.to.node !== 'parse')
    // Re-wire write/apply so the stripped narrator still validates as a turn (parse fed them).
    // Simplest: also drop the now-dangling edges that referenced parse (done above). apply/write
    // lose their parsed/mvu/metrics inputs but those are optional inputs (unwired is legal).

    const f = frag(
      fragmentDoc(
        [{ id: 'blk', type: 'text.template' }],
        [],
        [
          // Wants the missing checkpoint → skipped with warning.
          { kind: 'entry', checkpoint: 'reply-parsed', mode: 'branch', entryPort: { node: 'blk', port: 'gen' } },
          // Still valid → composed.
          { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }
        ]
      )
    )
    const { doc, warnings } = composeEffectiveGraph(n, [f])

    expect(warnings).toContainEqual({ packId: 'p', checkpoint: 'reply-parsed', reason: 'missing-checkpoint' })
    // The rejoin still landed.
    expect(
      doc.edges.some(
        (e) => e.from.node === packNodeId('p', 'blk') && e.to.node === 'assemble' && e.to.port === 'block'
      )
    ).toBe(true)
    const c = composition(doc)
    // The skipped entry is not in entries[]; the fragment node still spliced (it produces the rejoin).
    expect(c.packs['p'].entries).toEqual([])
    expect(c.packs['p'].nodeIds).toEqual([packNodeId('p', 'blk')])
  })
})

describe('composeEffectiveGraph — anchor lanes + per-port fan-in (WP1.6b)', () => {
  // prompt-assembly now has TWO anchor lanes on the assemble node: `block` (Text, default) and
  // `entries` (the placement-carrying lane). A rejoin picks its lane via `anchor`; fan-in is
  // guarded PER lane (one rejoin each), and an unknown selector is a visible skip.
  const rejoinFrag = (packId: string, anchor?: string): ComposeFragment =>
    frag(
      fragmentDoc(
        [{ id: 'blk', type: 'text.template' }],
        [],
        [
          {
            kind: 'rejoin',
            checkpoint: 'prompt-assembly',
            ...(anchor !== undefined ? { anchor } : {}),
            rejoinPort: { node: 'blk', port: 'text' }
          }
        ]
      ),
      { packId }
    )

  it('one pack on `block` + one on `entries` → BOTH splice, no warnings (fan-in is per lane)', () => {
    const { doc, warnings } = composeEffectiveGraph(narrator(), [
      rejoinFrag('pBlock'), // no selector = default lane (block)
      rejoinFrag('pEntries', 'entries')
    ])
    expect(warnings).toEqual([])
    expect(
      doc.edges.some(
        (e) => e.from.node === packNodeId('pBlock', 'blk') && e.to.node === 'assemble' && e.to.port === 'block'
      )
    ).toBe(true)
    expect(
      doc.edges.some(
        (e) => e.from.node === packNodeId('pEntries', 'blk') && e.to.node === 'assemble' && e.to.port === 'entries'
      )
    ).toBe(true)
    expect(validateWorkflow(doc, builtinRegistry.descriptors())).toEqual({ ok: true })
  })

  it('two packs on the SAME lane → the second is skipped with fanin-unmergeable', () => {
    const { doc, warnings } = composeEffectiveGraph(narrator(), [
      rejoinFrag('p1', 'entries'),
      rejoinFrag('p2', 'entries')
    ])
    expect(warnings).toContainEqual({ packId: 'p2', checkpoint: 'prompt-assembly', reason: 'fanin-unmergeable' })
    const feeds = doc.edges.filter((e) => e.to.node === 'assemble' && e.to.port === 'entries')
    expect(feeds).toHaveLength(1)
    expect(feeds[0].from.node).toBe(packNodeId('p1', 'blk'))
  })

  it('an explicit `block` selector and an absent selector are the SAME (default) lane — second skipped', () => {
    const { warnings } = composeEffectiveGraph(narrator(), [rejoinFrag('p1'), rejoinFrag('p2', 'block')])
    expect(warnings).toContainEqual({ packId: 'p2', checkpoint: 'prompt-assembly', reason: 'fanin-unmergeable' })
  })

  it('an unknown anchor selector is skipped with unknown-anchor-port (defensive; validation also rejects)', () => {
    const { doc, warnings } = composeEffectiveGraph(narrator(), [rejoinFrag('p', 'nope')])
    expect(warnings).toContainEqual({ packId: 'p', checkpoint: 'prompt-assembly', reason: 'unknown-anchor-port' })
    // Nothing landed on either lane.
    expect(
      doc.edges.some((e) => e.to.node === 'assemble' && (e.to.port === 'block' || e.to.port === 'entries'))
    ).toBe(false)
  })
})

describe('composeEffectiveGraph — determinism', () => {
  it('same inputs → deep-equal output (stable ordering)', () => {
    const build = (): ComposeFragment =>
      frag(
        fragmentDoc(
          [{ id: 'blk', type: 'text.template' }],
          [],
          [{ kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }]
        )
      )
    const a = composeEffectiveGraph(narrator(), [build()])
    const b = composeEffectiveGraph(narrator(), [build()])
    expect(a.doc).toEqual(b.doc)
    expect(a.warnings).toEqual(b.warnings)
  })
})
