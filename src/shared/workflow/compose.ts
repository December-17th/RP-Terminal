// Effective-graph composition for agent packs (WP1.2): fold a narrator workflow plus every enabled
// fragment into ONE runnable `kind:'turn'` doc — the effective graph the engine executes for a turn.
//
// Spec: docs/superpowers/specs/2026-07-03-agent-pack-workflow-ux-design-revision-3.md §Runtime
// Model. Decisions:
//  - ADR 0001 (agent packs compose into one effective graph per turn).
//  - ADR 0002 (fragments attach at narrator checkpoints; disabling gates the entry edge; a
//    fragment naming a checkpoint the narrator lacks is skipped with a VISIBLE warning).
//  - ADR 0009 (one pack, one graph, many attachments — all attachments splice from ONE copy of the
//    fragment's nodes; the gate is per-pack).
// Glossary: root CONTEXT.md (effective graph, gate, branch/inline fragment, checkpoint).
//
// Pure: imports only sibling shared/workflow modules — no main/renderer/preload/electron (enforced
// by `npm run check:deps`, rule `workflow-engine-pure`).
//
// ── Attachment-designation convention (module contract) ──────────────────────────────────────────
// A fragment designates WHICH of its own nodes/ports serve each attachment INLINE on the attachment
// decl (attachments.ts: EntryAttachment.entryPort/outPort, RejoinAttachment.rejoinPort). This
// MIRRORS the intent of subgraph boundary ports (subgraphNodes.ts:53-94 mark boundaries with
// `subgraph.input`/`subgraph.output` nodes carrying a `slot` config) but does NOT reuse those node
// types: they are validation-forbidden outside a `kind:'subgraph'` doc (validate.ts BOUNDARY_IN_TURN
// fires for a fragment), so a fragment names its boundary port on the attachment instead. This is
// the minimal convention that needs no new node types. Flagged for owner review in the WP report.
//
// ── Trace attribution (documented contract) ─────────────────────────────────────────────────────
// Every spliced fragment node id is prefixed EXACTLY `pack:<packId>:` (see PACK_PREFIX / packNodeId).
// The engine (WP1.3) and run-history (WP2.3) derive pack attribution from this prefix; do not change
// the prefix shape without updating those consumers.
//
// ── Controller decisions (recorded 2026-07-03, WP1.2 follow-up; amended WP1.6b) ─────────────────
//  - ANCHOR LANES (WP1.6b): a checkpoint may expose several named anchor PORTS on its one anchor
//    node (checkpoints.ts CheckpointSpec.anchors — today only `prompt-assembly`: `block` Text +
//    `entries` LorebookEntry[]/Any). A rejoin selects its lane via RejoinAttachment.anchor (port
//    name); absent = the default lane (anchors[0]). Unknown selector = skipped with an
//    'unknown-anchor-port' warning (validation also rejects it earlier — UNKNOWN_ANCHOR).
//  - Fan-in at a rejoin sink: the skip-with-'fanin-unmergeable'-warning behavior STANDS, applied
//    PER ANCHOR PORT (WP1.6b) — one rejoin may land on each lane (`block` and `entries` can each
//    take one), a second rejoin on the SAME lane is skipped. An auto-inserted merge node is a
//    separate later WP (WP1.7 backlog). The occupied-check keys on the concrete (node, port) sink,
//    so the per-lane rule falls out of lane-specific sink ports.
//  - Stacked inline fragments at one checkpoint: the CONTRACT is "fragments array order = chain
//    order" — fragment i's inline output feeds fragment i+1's inline entry, and the last inline in
//    the array feeds the anchor's original consumers. Multi-inline wiring itself stays out of
//    WP1.2 scope (current single-inline behavior is unchanged and deterministic); a later WP
//    hardens the chain wiring against this documented order.

import { WorkflowDoc, NodeInstance, Edge, EdgeEnd } from './types'
import { CheckpointId, EntryAttachment, RejoinAttachment } from './attachments'
import { CHECKPOINTS, CheckpointSpec, resolveAnchorLane } from './checkpoints'

// ── Anchor location ──────────────────────────────────────────────────────────────────────────────

/** Where a checkpoint's anchor was found in a concrete narrator doc: the actual node id (which may
 *  differ from the anchor node TYPE if a custom narrator renamed it) plus the DEFAULT anchor port
 *  (anchors[0] — WP1.6b: a rejoin's `anchor` selector may re-target another lane on the SAME node;
 *  spliceRejoin resolves the lane port from the CheckpointSpec, only `nodeId` comes from here). */
export interface ResolvedAnchor {
  nodeId: string
  port: string
}

export interface FindAnchorsResult {
  /** The checkpoints this narrator exposes, resolved to concrete node ids. */
  anchors: Partial<Record<CheckpointId, ResolvedAnchor>>
  /** Checkpoints the narrator does NOT expose (anchor node absent, or ambiguous — see below). A
   *  fragment attachment naming one of these is skipped with a warning at compose time (ADR 0002). */
  missing: CheckpointId[]
}

/** Whether an anchor port is a value SOURCE (an output — entries read here, inline reroutes from
 *  here) or a value SINK (an input — rejoins feed here). Determined from the CheckpointSpec's
 *  anchor semantics: context-ready/reply-parsed/turn-committed anchor on OUTPUT ports; prompt-
 *  assembly anchors on INPUTS — both its lanes, `block` and `entries`, are inputs (checkpoints.ts
 *  evidence; a checkpoint's lanes share one direction). We record it per checkpoint so
 *  composition wires the right direction without re-deriving it from node descriptors (which live
 *  main-side and are out of this pure module's reach). */
const ANCHOR_KIND: Readonly<Record<CheckpointId, 'source' | 'sink'>> = {
  'context-ready': 'source',
  'prompt-assembly': 'sink',
  'reply-parsed': 'source',
  'turn-committed': 'source'
}

/** Locate each checkpoint's anchor in a narrator doc, matching by anchor node TYPE (not id) so a
 *  custom narrator that renamed the spine node ids still composes (ADR 0002: packs are portable
 *  across narrators exposing the same checkpoints).
 *
 *  Ambiguity: if two+ nodes share an anchor type we cannot safely guess which sits on the main path
 *  from this pure model alone, so the checkpoint is reported MISSING rather than silently picking
 *  one (the task's "do not guess silently"). A single node of the anchor type is unambiguous. */
export function findCheckpointAnchors(doc: WorkflowDoc): FindAnchorsResult {
  const anchors: Partial<Record<CheckpointId, ResolvedAnchor>> = {}
  const missing: CheckpointId[] = []

  // Iterate CHECKPOINTS in id order for deterministic `missing` ordering.
  for (const id of Object.keys(CHECKPOINTS) as CheckpointId[]) {
    const spec: CheckpointSpec = CHECKPOINTS[id]
    const candidates = doc.nodes.filter((n) => n.type === spec.anchorNode)
    if (candidates.length === 1) {
      anchors[id] = { nodeId: candidates[0].id, port: spec.anchorPort }
    } else {
      // 0 candidates → absent; 2+ → ambiguous. Both are "narrator does not (unambiguously) expose
      // this checkpoint" → report missing, never guess.
      missing.push(id)
    }
  }
  return { anchors, missing }
}

// ── Composition ──────────────────────────────────────────────────────────────────────────────────

/** The exact node-id prefix stamped on every spliced fragment node. Trace attribution (WP1.3/2.3)
 *  parses this — treat it as a stable contract. */
export const PACK_PREFIX = 'pack:'

/** Namespaced id for a fragment node `nodeId` belonging to `packId`. */
export function packNodeId(packId: string, nodeId: string): string {
  return `${PACK_PREFIX}${packId}:${nodeId}`
}

/** A fragment to splice into the narrator. */
export interface ComposeFragment {
  packId: string
  doc: WorkflowDoc
  /** ADR 0002/0009: a closed gate means the fragment is not spliced AT ALL (per-pack, one act). */
  gateOpen: boolean
  /** WP-later denial hook (ADR 0007): indexes into `doc.attachments` whose ENTRY is closed. A
   *  closed entry is not spliced, and anything reachable ONLY through it is dropped too. Absent =
   *  no closed entries. Indexes that don't point at an entry attachment are ignored. */
  closedEntryIndexes?: number[]
}

/** Why an attachment could not be spliced (ADR 0002: visible, never silent). */
export interface ComposeWarning {
  packId: string
  checkpoint?: CheckpointId
  reason:
    | 'missing-checkpoint' // narrator lacks (or ambiguously exposes) the named checkpoint
    | 'no-port-designation' // entry/rejoin declared no entryPort/rejoinPort/outPort to splice
    | 'anchor-direction-mismatch' // e.g. a rejoin at a source-only anchor, or entry at a sink
    | 'fanin-unmergeable' // the SELECTED anchor lane already has an incoming edge (per-port, WP1.6b)
    | 'missing-fragment-node' // a designated port names a node not in the fragment doc
    | 'unknown-anchor-port' // WP1.6b: rejoin `anchor` selector names no lane on this checkpoint
}

/** One rejoin edge actually spliced: the fragment's (prefixed) producing output → the checkpoint
 *  anchor's input, tagged with the checkpoint it landed on. WP1.3 needs exactly these edges to
 *  treat a failed branch's rejoin input as absent, without re-deriving composition. */
export interface SplicedRejoinEdge {
  from: EdgeEnd
  to: EdgeEnd
  checkpoint: CheckpointId
}

/** What the engine (WP1.3) needs to know per pack after composition: which effective-graph node ids
 *  belong to the pack, each spliced entry's checkpoint + mode, each node's failure mode, and the
 *  rejoin edges spliced. JSON-serializable (stored on the composed doc's `meta.composition`). */
export interface PackComposition {
  /** Effective-graph (prefixed) node ids contributed by this pack that survived composition. */
  nodeIds: string[]
  /** Each entry actually spliced (post-gate, post-denial, post-reachability). */
  entries: { checkpoint: CheckpointId; mode: 'branch' | 'inline' }[]
  /** Per-node failure mode, keyed by the PREFIXED effective-graph node id (same keys as
   *  `nodeIds`): 'inline' if the node is reachable — within the fragment's OWN graph — from ANY
   *  inline entry that was actually spliced; otherwise 'branch'. Rationale: a rejoining branch IS
   *  an ancestor of the main output in the COMPOSED graph (its rejoin edge feeds the main path), so
   *  graph ancestry cannot distinguish load-bearing nodes from fail-open ones — only entry-mode
   *  reachability can. A node reachable from both an inline and a branch entry is 'inline'
   *  (load-bearing wins: if the main flow can depend on it, it must keep fatal semantics). */
  nodeModes: Record<string, 'branch' | 'inline'>
  /** The rejoin edges this pack contributed (see SplicedRejoinEdge). Empty if none spliced. */
  rejoinEdges: SplicedRejoinEdge[]
}

export interface CompositionMeta {
  packs: Record<string, PackComposition>
}

export interface ComposeResult {
  doc: WorkflowDoc
  warnings: ComposeWarning[]
}

/** Compose the narrator with every enabled fragment into one effective `kind:'turn'` doc.
 *
 *  - `compose(narrator, [])` returns the narrator UNCHANGED (deep-equal, ids untouched) — the
 *    zero-packs identity guarantee (WP1.3 relies on it for byte-identical no-pack behavior).
 *  - Deterministic: fragments are processed in the given array order; a fragment's own nodes/edges
 *    keep their relative order; ids are stable functions of (packId, original id).
 *  - Closed gate → fragment skipped entirely (ADR 0009). Closed entry index → that entry not
 *    spliced; fragment nodes reachable ONLY through closed entries are dropped (reachability over
 *    the fragment graph from the OPEN entries).
 *  - A fragment attachment naming a checkpoint the narrator lacks is skipped with a
 *    'missing-checkpoint' warning; the rest of the fragment still composes (ADR 0002). */
export function composeEffectiveGraph(
  narrator: WorkflowDoc,
  fragments: ComposeFragment[]
): ComposeResult {
  // Identity fast-path: no fragments (or none enabled) → the narrator, untouched. Checked up front
  // so the returned object is === the input when literally nothing is asked of us; the loop below
  // would otherwise deep-clone. We still short-circuit if every fragment is gated off.
  const enabled = fragments.filter((f) => f.gateOpen)
  if (enabled.length === 0) return { doc: narrator, warnings: [] }

  const { anchors } = findCheckpointAnchors(narrator)
  const warnings: ComposeWarning[] = []
  const composition: CompositionMeta = { packs: {} }

  // Work on a deep clone so the narrator input is never mutated (id stability of the input object).
  const out: WorkflowDoc = structuredClone(narrator)
  // A composed doc is a runnable turn doc (never itself a fragment/subgraph).
  out.kind = 'turn'

  for (const frag of enabled) {
    spliceFragment(out, frag, anchors, warnings, composition)
  }

  out.meta = { ...(out.meta ?? {}), composition }
  return { doc: out, warnings }
}

// ── internal ─────────────────────────────────────────────────────────────────────────────────────

/** Splice one enabled fragment's nodes + attachment edges into `out` (mutated in place). */
function spliceFragment(
  out: WorkflowDoc,
  frag: ComposeFragment,
  anchors: Partial<Record<CheckpointId, ResolvedAnchor>>,
  warnings: ComposeWarning[],
  composition: CompositionMeta
): void {
  const { packId, doc: fdoc } = frag
  const attachments = fdoc.attachments ?? []
  const closed = new Set(frag.closedEntryIndexes ?? [])

  // Which entry attachments are OPEN (not denied). Reachability is computed from the fragment nodes
  // designated by OPEN entries; anything reachable only through a closed entry is dropped.
  const openEntrySeeds: string[] = []
  attachments.forEach((att, i) => {
    if (att.kind !== 'entry') return
    if (closed.has(i)) return
    if (att.entryPort) openEntrySeeds.push(att.entryPort.node)
  })

  // Reachability over the fragment's OWN graph, forward from the open-entry seed nodes. Rejoin/
  // trigger attachments do not "close" — a rejoin's producing node is reachable if the fragment's
  // internal wiring reaches it from an open entry (or it is itself a seed). If a fragment has open
  // entries, only nodes reachable from them survive; if it has NO entry attachments at all (pure
  // rejoin/trigger fragment), every node survives (nothing gates them).
  const hasEntryAttachments = attachments.some((a) => a.kind === 'entry')
  const reachable = hasEntryAttachments
    ? reachableFrom(fdoc, openEntrySeeds)
    : new Set(fdoc.nodes.map((n) => n.id))

  // Splice the surviving fragment nodes (prefixed). Preserve original node order for determinism.
  const survivingNodes = fdoc.nodes.filter((n) => reachable.has(n.id))
  const packNodeIds: string[] = []
  for (const n of survivingNodes) {
    const cloned: NodeInstance = structuredClone(n)
    cloned.id = packNodeId(packId, n.id)
    // A fragment node is never the main output of the effective graph — the narrator owns that.
    delete cloned.isMainOutput
    out.nodes.push(cloned)
    packNodeIds.push(cloned.id)
  }

  // Internal fragment edges between two surviving nodes, prefixed.
  for (const e of fdoc.edges) {
    if (!reachable.has(e.from.node) || !reachable.has(e.to.node)) continue
    out.edges.push(prefixEdge(packId, e))
  }

  // Attachment edges (entry / rejoin). Trigger attachments contribute nothing to composition.
  const splicedEntries: PackComposition['entries'] = []
  // Un-prefixed fragment node ids of the entryPorts of inline entries ACTUALLY spliced — the seeds
  // for the nodeModes reachability pass below.
  const inlineSeeds: string[] = []
  const rejoinEdges: SplicedRejoinEdge[] = []
  attachments.forEach((att, i) => {
    if (att.kind === 'trigger') return
    if (att.kind === 'entry') {
      if (closed.has(i)) return
      spliceEntry(out, packId, att, anchors, reachable, warnings, splicedEntries, inlineSeeds)
    } else {
      spliceRejoin(out, packId, att, anchors, reachable, warnings, rejoinEdges)
    }
  })

  // Per-node failure mode (WP1.3 engine policy input): 'inline' iff reachable — within the
  // fragment's OWN graph — from any inline entry that was actually spliced; else 'branch'.
  // See PackComposition.nodeModes for the full rationale (rejoining branches are ancestors of the
  // main output in the composed graph, so composed-graph ancestry cannot distinguish load-bearing
  // nodes; only entry-mode reachability can — and load-bearing wins on overlap).
  const inlineReach = reachableFrom(fdoc, inlineSeeds)
  const nodeModes: PackComposition['nodeModes'] = {}
  for (const n of survivingNodes) {
    nodeModes[packNodeId(packId, n.id)] = inlineReach.has(n.id) ? 'inline' : 'branch'
  }

  composition.packs[packId] = { nodeIds: packNodeIds, entries: splicedEntries, nodeModes, rejoinEdges }
}

/** Wire an entry attachment: the checkpoint's value source → the fragment's `entryPort` input.
 *  Inline additionally re-routes the main flow THROUGH the fragment (anchor's downstream consumers
 *  are repointed from the anchor value onto the fragment's `outPort`). */
function spliceEntry(
  out: WorkflowDoc,
  packId: string,
  att: EntryAttachment,
  anchors: Partial<Record<CheckpointId, ResolvedAnchor>>,
  reachable: Set<string>,
  warnings: ComposeWarning[],
  splicedEntries: PackComposition['entries'],
  inlineSeeds: string[]
): void {
  const anchor = anchors[att.checkpoint]
  if (!anchor) {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'missing-checkpoint' })
    return
  }
  if (ANCHOR_KIND[att.checkpoint] !== 'source') {
    // An entry reads a VALUE; only source anchors (outputs) carry one to read. prompt-assembly's
    // `block` is an input — entering there is not meaningful.
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'anchor-direction-mismatch' })
    return
  }
  if (!att.entryPort) {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'no-port-designation' })
    return
  }
  if (!reachable.has(att.entryPort.node)) {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'missing-fragment-node' })
    return
  }

  const source: EdgeEnd = { node: anchor.nodeId, port: anchor.port }
  const entryIn: EdgeEnd = {
    node: packNodeId(packId, att.entryPort.node),
    port: att.entryPort.port
  }

  if (att.mode === 'inline') {
    if (!att.outPort || !reachable.has(att.outPort.node)) {
      warnings.push({ packId, checkpoint: att.checkpoint, reason: 'no-port-designation' })
      return
    }
    const outEnd: EdgeEnd = {
      node: packNodeId(packId, att.outPort.node),
      port: att.outPort.port
    }
    // Re-route: every edge that previously read the anchor value now reads the fragment's output.
    // Then feed the anchor value into the fragment entry. Net: upstream → fragment → old consumers.
    for (const e of out.edges) {
      if (e.from.node === source.node && e.from.port === source.port) {
        // Skip the entry edge we are about to add (it legitimately reads the anchor).
        e.from = { ...outEnd }
      }
    }
    out.edges.push({ from: { ...source }, to: entryIn })
    inlineSeeds.push(att.entryPort.node)
  } else {
    // Branch: main flow untouched — just tee the anchor value into the fragment entry.
    out.edges.push({ from: { ...source }, to: entryIn })
  }

  splicedEntries.push({ checkpoint: att.checkpoint, mode: att.mode })
}

/** Wire a rejoin attachment: the fragment's `rejoinPort` output → the SELECTED anchor lane's input
 *  on the checkpoint anchor node (WP1.6b: `att.anchor` picks the lane; absent = the default). */
function spliceRejoin(
  out: WorkflowDoc,
  packId: string,
  att: RejoinAttachment,
  anchors: Partial<Record<CheckpointId, ResolvedAnchor>>,
  reachable: Set<string>,
  warnings: ComposeWarning[],
  rejoinEdges: SplicedRejoinEdge[]
): void {
  const anchor = anchors[att.checkpoint]
  if (!anchor) {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'missing-checkpoint' })
    return
  }
  if (ANCHOR_KIND[att.checkpoint] !== 'sink') {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'anchor-direction-mismatch' })
    return
  }
  // WP1.6b: resolve the anchor LANE this rejoin lands on. Validation already rejects an unknown
  // selector (UNKNOWN_ANCHOR); this is the defensive compose-time counterpart for docs that
  // bypassed validation — visible skip, never a silent guess.
  const lane = resolveAnchorLane(CHECKPOINTS[att.checkpoint], att.anchor)
  if (!lane) {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'unknown-anchor-port' })
    return
  }
  if (!att.rejoinPort) {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'no-port-designation' })
    return
  }
  if (!reachable.has(att.rejoinPort.node)) {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'missing-fragment-node' })
    return
  }

  const sink: EdgeEnd = { node: anchor.nodeId, port: lane.port }
  // FAN-IN GUARD: validate.ts rejects an input port with 2+ incoming edges (FANIN). If another edge
  // already feeds this anchor input (a narrator producer, or an earlier pack's rejoin), we cannot
  // splice a second one without a merge node. Skip with a visible warning rather than emit a doc
  // that validate() will reject. PER ANCHOR PORT (WP1.6b): the check keys on the concrete
  // (node, port) sink, so `block` and `entries` each admit one rejoin independently; only a second
  // rejoin on the SAME lane is skipped. (A merge node for same-lane fan-in is WP1.7 backlog.)
  const occupied = out.edges.some((e) => e.to.node === sink.node && e.to.port === sink.port)
  if (occupied) {
    warnings.push({ packId, checkpoint: att.checkpoint, reason: 'fanin-unmergeable' })
    return
  }

  const outEnd: EdgeEnd = {
    node: packNodeId(packId, att.rejoinPort.node),
    port: att.rejoinPort.port
  }
  out.edges.push({ from: outEnd, to: sink })
  // Record the spliced edge for WP1.3: on a failed branch the engine treats exactly this rejoin
  // input as absent (fail-open) — it must find the edge without re-deriving composition.
  rejoinEdges.push({ from: { ...outEnd }, to: { ...sink }, checkpoint: att.checkpoint })
}

/** Prefix both ends of a fragment-internal edge with the pack id. */
function prefixEdge(packId: string, e: Edge): Edge {
  return {
    from: { node: packNodeId(packId, e.from.node), port: e.from.port },
    to: { node: packNodeId(packId, e.to.node), port: e.to.port }
  }
}

/** Forward reachability over `doc`'s own node graph from `seeds` (BFS along edges). Nodes not
 *  reachable from any seed are excluded (the denial-drop rule: reachable ONLY through a closed
 *  entry ⇒ not reachable from any open seed ⇒ dropped). */
function reachableFrom(doc: WorkflowDoc, seeds: string[]): Set<string> {
  const adj = new Map<string, string[]>()
  for (const n of doc.nodes) adj.set(n.id, [])
  for (const e of doc.edges) {
    if (adj.has(e.from.node) && adj.has(e.to.node)) adj.get(e.from.node)!.push(e.to.node)
  }
  const seen = new Set<string>()
  const queue = seeds.filter((s) => adj.has(s))
  for (const s of queue) seen.add(s)
  while (queue.length) {
    const cur = queue.shift()!
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}
