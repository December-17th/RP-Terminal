import { describe, it, expect } from 'vitest'
import {
  composeEffectiveGraph,
  ComposeFragment,
  PACK_PREFIX
} from '../../src/shared/workflow/compose'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { topoOrder } from '../../src/shared/workflow/graph'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { NARRATOR_SPINE_DOC as DEFAULT_GRAPH } from '../fixtures/narratorSpineDoc'
import {
  ASYNC_MEMORY_FRAGMENT,
  ASYNC_MEMORY_PACK_ID,
  ASYNC_MEMORY_BACKLOG_N,
  ASYNC_MEMORY_WATCH_TABLE,
  buildAsyncMemoryPack
} from '../../src/main/services/nodes/builtin/asyncMemoryPack'
import { BUILTIN_PACKS } from '../../src/main/services/nodes/builtin/tableMemoryPack'
import { TriggerAttachment } from '../../src/shared/workflow/attachments'

// WP2.4 pack hygiene — the flagship async-memory pack. Proves: it VALIDATES as a fragment, COMPOSES
// warning-free onto the real narrator spine (DEFAULT_GRAPH) yielding a runnable turn doc, the gate is
// closed-by-default (seeded but no activation row → off), builtin ⇒ uninstallable, and the three
// attachments (inline trimmer + branch export/rejoin + backlog trigger) are wired as specified. The
// headless COMPACTION behavior end-to-end is asyncMemoryFlagship.test.ts's job.

const frag = (over: Partial<ComposeFragment> = {}): ComposeFragment => ({
  packId: ASYNC_MEMORY_PACK_ID,
  doc: ASYNC_MEMORY_FRAGMENT,
  gateOpen: true,
  ...over
})

const compose = (f: ComposeFragment) => composeEffectiveGraph(structuredClone(DEFAULT_GRAPH), [f])

describe('async-memory fragment — validity', () => {
  it('is a well-formed fragment (passes validate as kind:fragment)', () => {
    const v = validateWorkflow(ASYNC_MEMORY_FRAGMENT, builtinRegistry.descriptors())
    if (!v.ok) throw new Error(v.errors.map((e) => e.message).join('; '))
    expect(v.ok).toBe(true)
  })

  it('declares exactly the three attachment KINDS: an inline entry, a rejoin, and a trigger', () => {
    const atts = ASYNC_MEMORY_FRAGMENT.attachments ?? []
    // one INLINE entry (the trimmer)
    const inline = atts.filter((a) => a.kind === 'entry' && a.mode === 'inline')
    expect(inline).toHaveLength(1)
    expect((inline[0] as { entryPort: unknown }).entryPort).toEqual({ node: 'trim', port: 'gen' })
    expect((inline[0] as { outPort: unknown }).outPort).toEqual({ node: 'trim', port: 'gen' })
    // one rejoin at prompt-assembly on the entries lane (the export injector)
    const rejoin = atts.filter((a) => a.kind === 'rejoin')
    expect(rejoin).toEqual([
      {
        kind: 'rejoin',
        checkpoint: 'prompt-assembly',
        anchor: 'entries',
        rejoinPort: { node: 'export', port: 'entries' }
      }
    ])
    // exactly one trigger (the backlog compactor)
    expect(atts.filter((a) => a.kind === 'trigger')).toHaveLength(1)
  })

  it('the trigger is a table/unprocessed gte N state trigger with the fixed v0 N + table', () => {
    const trigger = (ASYNC_MEMORY_FRAGMENT.attachments ?? []).find(
      (a) => a.kind === 'trigger'
    ) as TriggerAttachment & { source: { scope: string; table: string; stat: string } }
    expect(trigger).toMatchObject({
      trigger: 'state',
      source: { scope: 'table', table: ASYNC_MEMORY_WATCH_TABLE, stat: 'unprocessed' },
      op: 'gte',
      value: ASYNC_MEMORY_BACKLOG_N
    })
    expect(ASYNC_MEMORY_BACKLOG_N).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(ASYNC_MEMORY_BACKLOG_N)).toBe(true)
  })
})

describe('async-memory pack — composition onto the narrator spine', () => {
  const { doc: effective, warnings } = compose(frag())

  it('composes with NO warnings (every non-trigger attachment splices cleanly)', () => {
    expect(warnings).toEqual([])
  })

  it('yields a runnable turn doc (passes validate)', () => {
    expect(effective.kind).toBe('turn')
    const v = validateWorkflow(effective, builtinRegistry.descriptors())
    if (!v.ok) throw new Error(v.errors.map((e) => e.message).join('; '))
    expect(v.ok).toBe(true)
  })

  it('splices the trimmer INLINE: ctx → trim → (old ctx consumers), and re-points assemble.gen', () => {
    const trim = `${PACK_PREFIX}${ASYNC_MEMORY_PACK_ID}:trim`
    // ctx.gen feeds the trimmer's input.
    const intoTrim = effective.edges.find((e) => e.to.node === trim && e.to.port === 'gen')
    expect(intoTrim?.from).toEqual({ node: 'ctx', port: 'gen' })
    // assemble.gen now reads the TRIMMED context (the inline reroute), not ctx directly.
    const assembleGen = effective.edges.find((e) => e.to.node === 'assemble' && e.to.port === 'gen')
    expect(assembleGen?.from).toEqual({ node: trim, port: 'gen' })
  })

  it('injects the table export on the entries lane (export.entries → assemble.entries)', () => {
    const exp = `${PACK_PREFIX}${ASYNC_MEMORY_PACK_ID}:export`
    const entriesEdge = effective.edges.find(
      (e) => e.to.node === 'assemble' && e.to.port === 'entries'
    )
    expect(entriesEdge?.from).toEqual({ node: exp, port: 'entries' })
  })

  it('runs the trimmer BEFORE assemble in a valid topo order (inline transform precedes the prompt)', () => {
    const order = topoOrder(effective)
    const rank = new Map(order.map((id, i) => [id, i]))
    const trim = `${PACK_PREFIX}${ASYNC_MEMORY_PACK_ID}:trim`
    expect(rank.get(trim)!).toBeLessThan(rank.get('assemble')!)
  })
})

describe('async-memory pack — gate closed = clean removal', () => {
  it('gate closed → effective doc IS the plain narrator (no residue)', () => {
    const narrator = structuredClone(DEFAULT_GRAPH)
    const { doc, warnings } = composeEffectiveGraph(narrator, [frag({ gateOpen: false })])
    expect(doc).toBe(narrator)
    expect(doc.nodes.some((n) => n.id.startsWith(PACK_PREFIX))).toBe(false)
    expect(warnings).toEqual([])
  })
})

describe('async-memory pack — builtin record', () => {
  const record = buildAsyncMemoryPack()

  it('is builtin (uninstallable) with a stable id + version', () => {
    expect(record.id).toBe('builtin.async-memory')
    expect(record.builtin).toBe(true)
    expect(record.version).toBe(1)
  })

  it('is NO LONGER seeded via BUILTIN_PACKS (WP6.2 emptied the seed list; the builder is kept for the pack-machinery tests)', () => {
    // One-canvas rebuild (ADR 0011): the memory experiences ship as trigger-rooted chains in example
    // workflow docs, so BUILTIN_PACKS is empty. buildAsyncMemoryPack() still exists (this file exercises
    // it), it is just no longer auto-seeded into a fresh library.
    expect(BUILTIN_PACKS).toHaveLength(0)
  })

  it('manifest describes it as an alternative to the every-turn pack (not stackable)', () => {
    expect(record.manifest.name).toBe('Async Table Memory')
    // Microcopy sanity: the description tells the user to pick one memory system, not both.
    expect(record.manifest.description.toLowerCase()).toContain('alternative')
  })
})
