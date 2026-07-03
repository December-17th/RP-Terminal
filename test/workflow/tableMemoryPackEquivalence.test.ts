import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { composeEffectiveGraph, ComposeFragment, PACK_PREFIX } from '../../src/shared/workflow/compose'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { topoOrder } from '../../src/shared/workflow/graph'
import { WorkflowDoc, Edge } from '../../src/shared/workflow/types'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { DEFAULT_GRAPH } from '../../src/main/services/nodes/builtin/defaultGraph'
import {
  TABLE_MEMORY_FRAGMENT,
  TABLE_MEMORY_PACK_ID
} from '../../src/main/services/nodes/builtin/tableMemoryPack'

// WP1.6/WP1.6b — the ABI DOGFOOD. Proves the built-in SQL-Table-Memory pack, when composed onto the
// narrator spine, reproduces the shipped monolithic table-memory workflow
// (docs/workflows/table-memory-default.rptflow) EXACTLY — same node SET (modulo the pack:<id>:
// prefix), same edge SET (modulo prefix, ALL 44 edges), same topo-order constraints. WP1.6 found
// the prompt-injection edge (export.entries → assemble.entries) inexpressible against the
// block-only prompt-assembly anchor; WP1.6b resolved it with anchor LANES (checkpoints.ts
// CheckpointSpec.anchors + RejoinAttachment.anchor), and the fragment's rejoin now uses the
// `entries` lane — so the former principled-delta assertions below became exact ones.
//
// Composition is exercised against the REAL narrator (DEFAULT_GRAPH from main) exactly as
// compose.test.ts does — the monolith embeds that spine verbatim, so it is "the ORIGINAL narrator
// spine" WP1.6 asks for. The monolith's spine nodes/edges are asserted identical to DEFAULT_GRAPH
// below, closing the loop.

const monolithPath = path.join(__dirname, '../../docs/workflows/table-memory-default.rptflow')
const monolith = JSON.parse(fs.readFileSync(monolithPath, 'utf-8')) as WorkflowDoc

const NARRATOR_IDS = ['ctx', 'assemble', 'llm', 'parse', 'apply', 'write']
const prefix = `${PACK_PREFIX}${TABLE_MEMORY_PACK_ID}:`

/** Strip the pack:<id>: prefix off a composed node id, leaving the original fragment/narrator id. */
const stripPrefix = (id: string): string => (id.startsWith(prefix) ? id.slice(prefix.length) : id)

/** An edge with both endpoints de-prefixed, so composed edges compare directly to monolith edges. */
const deprefixEdge = (e: Edge): Edge => ({
  from: { node: stripPrefix(e.from.node), port: e.from.port },
  to: { node: stripPrefix(e.to.node), port: e.to.port }
})

const edgeKey = (e: Edge): string => `${e.from.node}.${e.from.port} -> ${e.to.node}.${e.to.port}`

const fragment = (over: Partial<ComposeFragment> = {}): ComposeFragment => ({
  packId: TABLE_MEMORY_PACK_ID,
  doc: TABLE_MEMORY_FRAGMENT,
  gateOpen: true,
  ...over
})

const compose = (frag: ComposeFragment) =>
  composeEffectiveGraph(structuredClone(DEFAULT_GRAPH), [frag])

describe('table-memory pack — narrator spine equivalence to DEFAULT_GRAPH', () => {
  // The whole equivalence argument rests on the monolith's spine BEING the builtin narrator. Pin it.
  it('the monolith embeds the DEFAULT_GRAPH spine verbatim (same spine nodes + edges)', () => {
    const spineNodes = monolith.nodes.filter((n) => NARRATOR_IDS.includes(n.id))
    expect(spineNodes.map((n) => n.id).sort()).toEqual([...NARRATOR_IDS].sort())

    // Every DEFAULT_GRAPH edge is present in the monolith (the spine wiring is unchanged).
    const monoEdgeSet = new Set(monolith.edges.map(edgeKey))
    for (const e of DEFAULT_GRAPH.edges) expect(monoEdgeSet.has(edgeKey(e))).toBe(true)
  })
})

describe('table-memory pack — composed effective graph vs monolith (gate OPEN)', () => {
  const { doc: effective, warnings } = compose(fragment())

  it('composes with NO warnings (every attachment splices cleanly)', () => {
    expect(warnings).toEqual([])
  })

  it('node SET equals the monolith modulo the pack prefix', () => {
    const composedIds = effective.nodes.map((n) => stripPrefix(n.id)).sort()
    const monolithIds = monolith.nodes.map((n) => n.id).sort()
    expect(composedIds).toEqual(monolithIds)
  })

  it('every table node carries the pack:<id>: prefix; narrator nodes do not', () => {
    for (const n of effective.nodes) {
      if (NARRATOR_IDS.includes(stripPrefix(n.id))) expect(n.id.startsWith(prefix)).toBe(false)
      else expect(n.id.startsWith(prefix)).toBe(true)
    }
  })

  it('edge SET equals the monolith modulo prefix — EXACT, all 44 edges (WP1.6b)', () => {
    const composedEdges = new Set(effective.edges.map((e) => edgeKey(deprefixEdge(e))))
    const monolithEdges = new Set(monolith.edges.map(edgeKey))

    // Exact set equality — including the injection edge WP1.6 could not express (the fragment's
    // rejoin now lands on the `entries` anchor lane, restoring export.entries → assemble.entries).
    expect(composedEdges).toEqual(monolithEdges)
    expect(monolithEdges.size).toBe(44)
    // Guard against duplicate edges hiding behind the set comparison.
    expect(effective.edges).toHaveLength(monolith.edges.length)
  })

  it('is a runnable turn doc (passes validate)', () => {
    expect(effective.kind).toBe('turn')
    const v = validateWorkflow(effective, builtinRegistry.descriptors())
    if (!v.ok) throw new Error(v.errors.map((e) => e.message).join('; '))
    expect(v.ok).toBe(true)
  })

  it('preserves the monolith execution-order constraints in a valid topo order', () => {
    const order = topoOrder(effective)
    const rank = new Map(order.map((id, i) => [stripPrefix(id), i]))

    // Load-bearing ordering constraints the monolith wired (and the pack must preserve):
    //  - the narrator spine order;
    //  - export BEFORE assemble (its projection feeds the prompt);
    //  - the maintenance chain runs AFTER the reply commits (write → gate) and in dependency order.
    const before = (a: string, b: string): void =>
      expect(rank.get(a)!).toBeLessThan(rank.get(b)!)

    before('ctx', 'assemble')
    before('assemble', 'llm')
    before('llm', 'parse')
    before('parse', 'apply')
    before('apply', 'write')

    before('export', 'assemble') // projection reaches the prompt before it is sent
    before('write', 'gate') // maintenance is post-commit (ordering edge write.floor → gate.floor)
    before('write', 'refresh')
    before('gate', 'read')
    before('gate', 'side')
    before('read', 'frame')
    before('recent', 'frame')
    before('frame', 'side')
    before('side', 'sql')
    before('sql', 'tableapply')
    before('side', 'log-side')
    before('tableapply', 'log-apply')
  })
})

describe('table-memory pack — clean removal (gate CLOSED)', () => {
  it('gate closed → effective doc DEEP-EQUALS the plain narrator (no node/edge/meta residue)', () => {
    const narratorInstance = structuredClone(DEFAULT_GRAPH)
    const { doc, warnings } = composeEffectiveGraph(narratorInstance, [fragment({ gateOpen: false })])
    // Identity guarantee: a gated-off fragment leaves the narrator untouched — the SAME object.
    expect(doc).toBe(narratorInstance)
    expect(doc).toEqual(DEFAULT_GRAPH)
    expect(doc.nodes.some((n) => n.id.startsWith(PACK_PREFIX))).toBe(false)
    expect(doc.meta).toBeUndefined()
    expect(warnings).toEqual([])
  })
})

describe('table-memory pack — injection lane (WP1.6 finding, RESOLVED by WP1.6b anchor lanes)', () => {
  // WP1.6 found the monolith's placement-carrying injection (export.entries → assemble.entries)
  // inexpressible: prompt-assembly anchored only on `block` (Text). WP1.6b gave the checkpoint two
  // anchor LANES (block + entries) selected via RejoinAttachment.anchor. Pin the exact wiring so
  // the restored equivalence can never silently drift back to the block lane.
  it('the fragment rejoins on the entries lane from export.entries — the monolith\'s exact edge', () => {
    const monolithInjection = monolith.edges.find(
      (e) => e.to.node === 'assemble' && e.to.port === 'entries'
    )
    expect(monolithInjection?.from).toEqual({ node: 'export', port: 'entries' })

    const rejoin = TABLE_MEMORY_FRAGMENT.attachments?.find((a) => a.kind === 'rejoin')
    expect(rejoin).toEqual({
      kind: 'rejoin',
      checkpoint: 'prompt-assembly',
      anchor: 'entries',
      rejoinPort: { node: 'export', port: 'entries' }
    })

    // And the composed graph carries it onto the real anchor node.
    const { doc } = compose(fragment())
    const spliced = doc.edges.find((e) => e.to.node === 'assemble' && e.to.port === 'entries')
    expect(spliced?.from).toEqual({ node: `${prefix}export`, port: 'entries' })
  })
})
