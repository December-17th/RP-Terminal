// Pure display-derivation for the Agents workspace Runs timeline (agent-packs plan WP3.3). Like
// agentPackDisplay.ts, everything here is side-effect-free and React-free so it is unit-testable
// directly (test/runTimeline.test.ts) under Node — the renderer's Runs pane (AgentsView.tsx) renders
// these shapes and adds only the localized labels + the DOM.
//
// What lives here (the pieces the WP asks be extracted + tested):
//   · trace node filtering + un-prefixing (drop synthetic __headless_seed_* nodes; split pack-prefixed
//     ids into { packId, nodeId } vs narrator).
//   · per-node grouping for the expandable detail (narrator group + one group per contributing pack).
//   · the one-sentence OUTCOME derivation — a pure sentence-BUILDER returning a t() key + vars (the
//     view interpolates via the {{var}} helper in i18n/index.ts). Counts ran/failed/skipped, calls out
//     table writes / floor writes / LLM calls, and names the failed node's type for failures.
//   · failed-branch-inside-ok-turn detection (run ok, but a pack node status failed).
//   · the client-side filter-chip set (packs that have runs in the loaded window).
//
// Grounding: shared/workflow/trace.ts (StoredRunRecord, TraceNode statuses ran/skipped/failed,
// WorkflowRunTrace.ok/aborted/error), shared/workflow/compose.ts (PACK_PREFIX / packNodeId — the
// `pack:<packId>:` id contract), the headless adapter's __headless_seed_* synthetic node ids
// (master-plan Amendment 2026-07-03 after WP2.1–2.2). Node TYPE strings verified against
// src/main/services/nodes/builtin/{tableNodes,generationNodes}.ts + capabilities.ts.

import { PACK_PREFIX } from '../../../../shared/workflow/compose'
import type { StoredRunRecord, TraceNode, WorkflowRunTrace } from '../../../../shared/workflow/trace'

// The synthetic seed-node id prefix the headless adapter injects (master-plan Amendment). These are
// NOT real fragment work — they exist only to feed turn Context into a headless sub-chain — and must
// never appear in the timeline's per-node detail.
export const HEADLESS_SEED_PREFIX = '__headless_seed_'

/** Node TYPE strings whose successful run is a user-visible EFFECT the one-liner should name. Kept as
 *  a small honest allow-list (not every node) — verified against the builtin node registry. */
export const TABLE_WRITE_TYPE = 'table.apply' // SQL-table-memory write (tableNodes.ts)
export const FLOOR_WRITE_TYPE = 'output.writeFloor' // writes the committed floor (generationNodes.ts)
export const LLM_CALL_TYPE = 'llm.sample' // samples the model (generationNodes.ts)

/** Is this a synthetic headless-seed node that must be hidden from display? */
export const isHeadlessSeedNode = (n: Pick<TraceNode, 'nodeId'>): boolean =>
  n.nodeId.startsWith(HEADLESS_SEED_PREFIX)

/** Split a trace node's id into its owning pack + the un-prefixed node id, or null for a narrator
 *  node. The pack-prefixed id contract is `pack:<packId>:<originalNodeId>` (compose.ts packNodeId);
 *  the packId is the segment between `pack:` and the NEXT colon (pack ids are opaque). */
export function unprefixNode(nodeId: string): { packId: string; nodeId: string } | null {
  if (!nodeId.startsWith(PACK_PREFIX)) return null
  const rest = nodeId.slice(PACK_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  return { packId: rest.slice(0, colon), nodeId: rest.slice(colon + 1) }
}

// ── Per-node grouping for the expandable detail ────────────────────────────────────────────────────

/** One node row in the expanded detail — the un-prefixed id (what the editor titles) + its outcome. */
export interface DetailNode {
  /** The display node id (un-prefixed for pack nodes; raw for narrator). */
  nodeId: string
  /** The node's registry type — the view maps this to the editor's localized title. */
  nodeType: string
  status: TraceNode['status']
  ms?: number
  error?: { message: string }
}

/** A group of nodes under one heading. `packId` null = the narrator group (nodes with no pack prefix);
 *  otherwise the contributing pack's id (the view resolves it to a pack NAME). */
export interface DetailGroup {
  packId: string | null
  nodes: DetailNode[]
}

/** Build the grouped per-node detail for a run: drop synthetic seed nodes, un-prefix pack ids, and
 *  bucket into a narrator group + one group per contributing pack. Group ORDER follows first
 *  appearance in the trace (stable, matches run order); node order within a group is trace order.
 *  The narrator group is emitted only if it has nodes. */
export function detailGroups(trace: WorkflowRunTrace): DetailGroup[] {
  const groups: DetailGroup[] = []
  const byKey = new Map<string, DetailGroup>() // key: '' for narrator, else packId
  for (const n of trace.nodes) {
    if (isHeadlessSeedNode(n)) continue
    const un = unprefixNode(n.nodeId)
    const packId = un ? un.packId : null
    const key = packId ?? ''
    let g = byKey.get(key)
    if (!g) {
      g = { packId, nodes: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    const row: DetailNode = {
      nodeId: un ? un.nodeId : n.nodeId,
      nodeType: n.nodeType,
      status: n.status
    }
    if (n.ms !== undefined) row.ms = n.ms
    if (n.error) row.error = { message: n.error.message }
    g.nodes.push(row)
  }
  return groups
}

// ── Outcome derivation (the one-sentence plain-language summary) ────────────────────────────────────
//
// The sentence is derived MECHANICALLY + HONESTLY from the trace: it counts the nodes that ran /
// failed / skipped (ignoring synthetic seed nodes) and calls out the concrete effects (table writes,
// floor writes, LLM calls). It returns a t() KEY + interpolation vars — the view renders it via
// translate()'s {{var}} substitution — so en/zh templates stay in the locale files, not here.
//
// NOTE (friction for WP3.5): the stored record carries NO floor number, so the brief's "after floor
// 38" phrasing is not derivable from the trace alone. The headless/manual trigger caption (a separate
// field, shown beside the sentence) carries the "why"; the sentence sticks to what ran + what changed.

/** The counted, honest facts a run's outcome sentence is built from. Pure tally over the FILTERED,
 *  non-seed trace nodes. `failedNodeType` is the type of the FIRST failed node (for naming it). */
export interface RunFacts {
  ran: number
  failed: number
  skipped: number
  tableWrites: number
  floorWrites: number
  llmCalls: number
  /** The registry type of the first failed node (view maps to a localized title), if any. */
  failedNodeType?: string
  /** True when the whole run failed/aborted (WorkflowRunTrace.ok === false). */
  runFailed: boolean
  /** True when the run SUCCEEDED overall but a node still failed — a failed BRANCH sub-path that did
   *  not affect the reply (the "X failed — the reply was not affected" case). */
  branchFailedInOkRun: boolean
}

/** Tally the honest facts from a run's trace (synthetic seed nodes excluded). */
export function runFacts(trace: WorkflowRunTrace): RunFacts {
  let ran = 0
  let failed = 0
  let skipped = 0
  let tableWrites = 0
  let floorWrites = 0
  let llmCalls = 0
  let failedNodeType: string | undefined
  for (const n of trace.nodes) {
    if (isHeadlessSeedNode(n)) continue
    if (n.status === 'ran') {
      ran++
      if (n.nodeType === TABLE_WRITE_TYPE) tableWrites++
      else if (n.nodeType === FLOOR_WRITE_TYPE) floorWrites++
      else if (n.nodeType === LLM_CALL_TYPE) llmCalls++
    } else if (n.status === 'failed') {
      failed++
      if (failedNodeType === undefined) failedNodeType = n.nodeType
    } else if (n.status === 'skipped') {
      skipped++
    }
  }
  const runFailed = !trace.ok
  return {
    ran,
    failed,
    skipped,
    tableWrites,
    floorWrites,
    llmCalls,
    ...(failedNodeType !== undefined ? { failedNodeType } : {}),
    runFailed,
    branchFailedInOkRun: !runFailed && failed > 0
  }
}

/** A localizable outcome sentence: a t() key + the interpolation vars it needs. The view calls
 *  t(key, vars). `failedNodeType` (when present) is a node TYPE the view must localize to a title
 *  before it becomes the `{{node}}` var — so it is returned SEPARATELY, not baked into vars. */
export interface OutcomeSentence {
  key: string
  vars: Record<string, string | number>
  /** When set, the view must resolve this node TYPE to its localized title and pass it as `node`. */
  failedNodeType?: string
}

/**
 * Build the one-sentence outcome for a run. Rules (checked in priority order):
 *   1. run failed/aborted         → runs.outcome.failed        (names the failed node type)
 *   2. ran + a branch node failed → runs.outcome.branchFailed  (names the failed node type;
 *                                    "… — the reply was not affected")
 *   3. table write(s) happened    → runs.outcome.updatedTables  ({{n}} tables)
 *   4. floor write(s) happened    → runs.outcome.wroteFloors    ({{n}} floors)
 *   5. LLM call(s) happened       → runs.outcome.calledModel    ({{n}} times)
 *   6. everything skipped (ran 0) → runs.outcome.skipped
 *   7. otherwise                  → runs.outcome.ran            ({{n}} steps)
 *
 * Effect callouts (3–5) combine when several apply: the highest-priority effect drives the key and
 * the others fold into a trailing "and …" clause handled by the *WithExtra keys — kept simple: we
 * pick ONE headline effect (table > floor > llm) and, if a second effect exists, use the paired
 * key that mentions "and more". A run with no headline effect but some steps uses runs.outcome.ran.
 */
export function outcomeSentence(facts: RunFacts): OutcomeSentence {
  if (facts.runFailed) {
    return facts.failedNodeType
      ? { key: 'runs.outcome.failed', vars: {}, failedNodeType: facts.failedNodeType }
      : { key: 'runs.outcome.failedGeneric', vars: {} }
  }
  if (facts.branchFailedInOkRun) {
    return facts.failedNodeType
      ? { key: 'runs.outcome.branchFailed', vars: {}, failedNodeType: facts.failedNodeType }
      : { key: 'runs.outcome.branchFailedGeneric', vars: {} }
  }

  // Effect callouts. Headline effect = table > floor > llm; a second effect adds "and more".
  const effects: { key: string; n: number }[] = []
  if (facts.tableWrites > 0) effects.push({ key: 'updatedTables', n: facts.tableWrites })
  if (facts.floorWrites > 0) effects.push({ key: 'wroteFloors', n: facts.floorWrites })
  if (facts.llmCalls > 0) effects.push({ key: 'calledModel', n: facts.llmCalls })

  if (effects.length > 0) {
    const head = effects[0]
    if (effects.length > 1) {
      return { key: `runs.outcome.${head.key}More`, vars: { n: head.n } }
    }
    return { key: `runs.outcome.${head.key}`, vars: { n: head.n } }
  }

  if (facts.ran === 0) {
    return { key: 'runs.outcome.skipped', vars: {} }
  }
  return { key: 'runs.outcome.ran', vars: { n: facts.ran } }
}

// ── Filter chips (client-side, over the loaded window) ──────────────────────────────────────────────

/** The set of pack ids that CONTRIBUTED to at least one run in the loaded records (for the per-pack
 *  filter chips). Uses record.packIds (already attributed by derivePackIds). Sorted + de-duplicated
 *  for a stable chip order; excludes runs with no packs (a plain narrator turn adds no chip). */
export function packsWithRuns(records: readonly StoredRunRecord[]): string[] {
  const ids = new Set<string>()
  for (const r of records) for (const id of r.packIds) ids.add(id)
  return [...ids].sort()
}

/** Apply a filter chip to the loaded records. `null` = All (no filter); otherwise keep only runs the
 *  pack contributed to (record.packIds includes it). Preserves input order (newest-first). */
export function filterRuns(
  records: readonly StoredRunRecord[],
  packId: string | null
): StoredRunRecord[] {
  if (packId === null) return [...records]
  return records.filter((r) => r.packIds.includes(packId))
}

/** The smallest seq in a page — the cursor to pass as the next `beforeSeq` (strictly-less-than paging,
 *  WP2.3 contract). Undefined for an empty page (nothing more to request). Records are newest-first so
 *  the smallest seq is the LAST element's, but we min defensively (order is a contract, not a law). */
export function nextBeforeSeq(page: readonly StoredRunRecord[]): number | undefined {
  if (page.length === 0) return undefined
  let min = page[0].seq
  for (const r of page) if (r.seq < min) min = r.seq
  return min
}
