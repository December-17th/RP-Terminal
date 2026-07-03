import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc } from '../../src/shared/workflow/types'
import { AttachmentDecl } from '../../src/shared/workflow/attachments'
import { composeEffectiveGraph, ComposeFragment, packNodeId } from '../../src/shared/workflow/compose'

// WP1.3 — composition-aware failure policy on the engine (ADR 0002: "failure semantics follow
// attachment mode, per edge — branch fragments fail open even before the reply; inline fragments
// are load-bearing and block the reply on failure"; agent-packs master plan WP1.3).
//
// These are NEW cases, additive to the engine.* characterization suites. They drive the engine
// through the REAL composition path: a small narrator + a real fragment are folded by
// composeEffectiveGraph, so the engine consumes the actual `meta.composition.nodeModes` a live
// turn would (never a hand-forged meta). Node run()s are controlled test impls so a chosen fragment
// node can throw.

const ctx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

// ── Registry: a minimal narrator spine + fragment nodes ─────────────────────────────────────────
// findCheckpointAnchors matches checkpoints by anchor node TYPE, so these MUST be named exactly
// `input.context` (context-ready, port `gen`) and `prompt.assemble` (prompt-assembly, port `block`).
// `assemble.block` is left unwired in the narrator, exactly like DEFAULT_GRAPH, so a fragment can
// rejoin there without a fan-in conflict.

/** Did the narrator's assemble node see a `block` input? Recorded per run so a test can assert the
 *  block was unwired (fail-open) vs wired (rejoin landed). */
let assembleSawBlock: boolean | undefined

const inputContext: NodeImpl = {
  type: 'input.context',
  title: 'context',
  inputs: [],
  outputs: [{ name: 'gen', type: 'Context' }],
  run: () => ({ outputs: { gen: { seed: true } } })
}

const promptAssemble: NodeImpl = {
  type: 'prompt.assemble',
  title: 'assemble',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'block', type: 'Text' }
  ],
  outputs: [{ name: 'out', type: 'Text' }],
  run: (_ctx, inputs) => {
    assembleSawBlock = 'block' in inputs && inputs.block !== undefined
    return { outputs: { out: 'assembled' } }
  }
}

const mainOut: NodeImpl = {
  type: 'main',
  title: 'main',
  inputs: [{ name: 'in', type: 'Text' }],
  outputs: [{ name: 'out', type: 'Text' }],
  isMainOutputCapable: true,
  run: (_ctx, inputs) => ({ outputs: { out: inputs.in ?? 'reply' } })
}

/** A fragment node that reads a Context on `gen` and produces a Text on `text` — but throws. */
const fragBoom: NodeImpl = {
  type: 'fragBoom',
  title: 'fragBoom',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'in1', type: 'Any' }
  ],
  outputs: [{ name: 'text', type: 'Text' }],
  run: () => {
    throw new Error('fragment kaboom')
  }
}

/** A well-behaved fragment node: reads `gen`/`in1`, emits Text on `text`. */
const fragOk: NodeImpl = {
  type: 'fragOk',
  title: 'fragOk',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'in1', type: 'Any' }
  ],
  outputs: [{ name: 'text', type: 'Text' }],
  run: () => ({ outputs: { text: 'from-fragment' } })
}

/** An INLINE-shaped throwing node: Context in → Context out (so composition's main-flow reroute
 *  type-checks against the narrator's Context spine), but it throws — the load-bearing failure case. */
const fragBoomInline: NodeImpl = {
  type: 'fragBoomInline',
  title: 'fragBoomInline',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [{ name: 'gen', type: 'Context' }],
  run: () => {
    throw new Error('fragment kaboom')
  }
}

const reg = createRegistry([inputContext, promptAssemble, mainOut, fragBoom, fragOk, fragBoomInline])

/** The narrator spine: ctx → assemble → main. `assemble.block` unwired (DEFAULT_GRAPH shape). */
const narrator = (): WorkflowDoc => ({
  id: 'nar',
  name: 'nar',
  version: 1,
  schemaVersion: 1,
  nodes: [
    { id: 'ctx', type: 'input.context' },
    { id: 'assemble', type: 'prompt.assemble' },
    { id: 'main', type: 'main', isMainOutput: true }
  ],
  edges: [
    { from: { node: 'ctx', port: 'gen' }, to: { node: 'assemble', port: 'gen' } },
    { from: { node: 'assemble', port: 'out' }, to: { node: 'main', port: 'in' } }
  ]
})

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

const status = (traces: { nodeId: string; status: string }[], id: string): string | undefined =>
  traces.find((t) => t.nodeId === id)?.status

describe('runWorkflow — branch fragment fails open in the pre-phase (WP1.3)', () => {
  it('a branch fragment node that throws does NOT abort the turn; main output is still produced', async () => {
    assembleSawBlock = undefined
    // Branch entry at context-ready → the fragment node → rejoin at prompt-assembly.block. This node
    // is a pre-phase ancestor of the main output (it feeds assemble.block), yet it must fail open.
    const branch = frag(
      fragmentDoc(
        [{ id: 'blk', type: 'fragBoom' }],
        [],
        [
          { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'blk', port: 'gen' } },
          { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }
        ]
      )
    )
    const { doc } = composeEffectiveGraph(narrator(), [branch])
    const res = await runWorkflow(doc, reg, ctx())

    expect(res.ok).toBe(true)
    expect(res.aborted).toBe(false)
    expect(res.error).toBeUndefined()
    // Main output ran and produced the reply.
    expect(status(res.traces, 'main')).toBe('ran')
    expect(res.outputs.get('main')?.out).toBe('assembled')
    // The fragment node is traced 'failed', attributed via its pack: prefix (unchanged id in trace).
    expect(status(res.traces, packNodeId('p', 'blk'))).toBe('failed')
    // The rejoin edge is treated as absent: assemble ran with `block` unwired (exactly as today when
    // nothing is wired there).
    expect(assembleSawBlock).toBe(false)
  })

  it('downstream fragment node is traced "skipped" when the upstream branch node throws', async () => {
    // Two chained fragment nodes: fBoom (branch entry) → fDown; fBoom throws → fDown can no longer
    // run (its only incoming edge is dead) → 'skipped'; the turn still completes.
    const branch = frag(
      fragmentDoc(
        [
          { id: 'fBoom', type: 'fragBoom' },
          { id: 'fDown', type: 'fragOk' }
        ],
        [{ from: { node: 'fBoom', port: 'text' }, to: { node: 'fDown', port: 'in1' } }],
        [
          { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'fBoom', port: 'gen' } },
          { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'fDown', port: 'text' } }
        ]
      )
    )
    const { doc } = composeEffectiveGraph(narrator(), [branch])
    const res = await runWorkflow(doc, reg, ctx())

    expect(res.ok).toBe(true)
    expect(status(res.traces, packNodeId('p', 'fBoom'))).toBe('failed')
    expect(status(res.traces, packNodeId('p', 'fDown'))).toBe('skipped')
    expect(status(res.traces, 'main')).toBe('ran')
  })
})

describe('runWorkflow — inline fragment keeps fatal semantics (WP1.3)', () => {
  it('an inline fragment node that throws aborts the turn exactly like a pre-phase failure', async () => {
    // Inline entry at context-ready: the main flow is wired THROUGH the fragment. fragBoom is
    // load-bearing ('inline' in nodeModes) → its throw is fatal, same as today's unwired pre-phase
    // failure (res.ok false, res.error names the node, main never ran).
    const inline = frag(
      fragmentDoc(
        [{ id: 'blk', type: 'fragBoomInline' }],
        [],
        [
          {
            kind: 'entry',
            checkpoint: 'context-ready',
            mode: 'inline',
            entryPort: { node: 'blk', port: 'gen' },
            // Inline re-routes the main Context flow THROUGH this node (Context in → Context out), so
            // the composed reroute type-checks against the narrator's Context spine. The node throws.
            outPort: { node: 'blk', port: 'gen' }
          }
        ]
      )
    )
    const { doc } = composeEffectiveGraph(narrator(), [inline])
    const res = await runWorkflow(doc, reg, ctx())

    expect(res.ok).toBe(false)
    expect(res.aborted).toBe(false)
    expect(res.error?.nodeId).toBe(packNodeId('p', 'blk'))
    expect(res.error?.message).toBe('fragment kaboom')
    // Main output never ran (fatal short-circuited the pre-phase).
    expect(status(res.traces, 'main')).not.toBe('ran')
  })
})

describe('runWorkflow — pure-rejoin fragment executes as a root (WP1.3)', () => {
  it('a fragment with ONLY a rejoin attachment runs (its node is a root) and its value reaches assemble.block', async () => {
    assembleSawBlock = undefined
    // No entry: the fragment node has no incoming edge in the composed graph (it is a root), but it
    // must still execute and its output rejoin the narrator at prompt-assembly.block.
    const pureRejoin = frag(
      fragmentDoc(
        [{ id: 'blk', type: 'fragOk' }],
        [],
        [{ kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }]
      )
    )
    const { doc } = composeEffectiveGraph(narrator(), [pureRejoin])
    const res = await runWorkflow(doc, reg, ctx())

    expect(res.ok).toBe(true)
    // The root fragment node ran even with no entry edge.
    expect(status(res.traces, packNodeId('p', 'blk'))).toBe('ran')
    expect(res.outputs.get(packNodeId('p', 'blk'))?.text).toBe('from-fragment')
    // Its value arrived at assemble.block.
    expect(assembleSawBlock).toBe(true)
    expect(status(res.traces, 'main')).toBe('ran')
  })
})

describe('runWorkflow — zero-composition identity (WP1.3 zero-packs guarantee)', () => {
  it('a doc WITHOUT meta.composition whose pre-phase node throws is STILL fatal (unchanged semantics)', async () => {
    // The narrator's assemble node throws (an unwired pre-phase failure) and the doc carries NO
    // meta.composition — the fail-open set is empty, so the original rule applies verbatim: fatal.
    const boomAssemble: NodeImpl = {
      type: 'boomAssemble',
      title: 'boomAssemble',
      inputs: [{ name: 'gen', type: 'Context' }],
      outputs: [{ name: 'out', type: 'Text' }],
      run: () => {
        throw new Error('assemble kaboom')
      }
    }
    const reg2 = createRegistry([inputContext, boomAssemble, mainOut])
    const doc: WorkflowDoc = {
      id: 'nar2',
      name: 'nar2',
      version: 1,
      schemaVersion: 1,
      nodes: [
        { id: 'ctx', type: 'input.context' },
        { id: 'assemble', type: 'boomAssemble' },
        { id: 'main', type: 'main', isMainOutput: true }
      ],
      edges: [
        { from: { node: 'ctx', port: 'gen' }, to: { node: 'assemble', port: 'gen' } },
        { from: { node: 'assemble', port: 'out' }, to: { node: 'main', port: 'in' } }
      ]
    }
    expect(doc.meta).toBeUndefined() // no composition metadata at all
    const res = await runWorkflow(doc, reg2, ctx())

    expect(res.ok).toBe(false)
    expect(res.error?.nodeId).toBe('assemble')
    expect(status(res.traces, 'main')).not.toBe('ran')
  })
})
