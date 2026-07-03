// Pure projection helpers for the Workflow view's EFFECTIVE mode (agent-packs plan WP3.6a; ADR 0010).
//
// EFFECTIVE mode renders the live composition for the active chat — the narrator doc composed with
// every gate-open pack fragment (main's resolveEffectiveDoc → compose.ts). This module is the
// React-free, side-effect-free half: it maps the composed doc + its `meta.composition` +
// the pack manifests the projection IPC returns into the shapes the canvas renders. NO React /
// @xyflow imports (mirrors editorModel.ts) so it stays vitest-testable under Node and immune to the
// renderer/main boundary (CLAUDE.md; check:deps forbids importing src/main here — we import only
// shared/workflow, which is pure).
//
// Grounding (read, not inferred):
//   · compose.ts stamps EVERY spliced fragment node id EXACTLY `pack:<packId>:<origId>` (PACK_PREFIX
//     contract). ownerOf() is the inverse; a node id without the prefix belongs to the narrator.
//   · compose.ts records per-pack composition under `doc.meta.composition.packs[packId]`:
//     { nodeIds, entries, nodeModes, rejoinEdges } (CompositionMeta / PackComposition). We consume it
//     read-only for grouping + splice-edge classification — the task forbids touching compose.ts, and
//     it already carries everything grouping needs.
//   · A gate-open pack can contribute ZERO surviving spliced nodes (its `nodeIds` is empty) — the
//     async-memory flagship is the real case: its maintenance chain declares NO context-ready entry
//     attachment, so reachableFrom(open-entry seeds) never reaches it and compose DROPS it from a
//     turn (asyncMemoryPack.ts `mctx` comment; compose.ts:250-253 reachability). That pack still
//     splices its `trim` + `export` nodes, so it is NOT trigger-only. A pack whose ONLY attachment is
//     a trigger contributes nothing spliced → `triggerOnly` → rendered as a DETACHED placeholder
//     region (ADR 0010's last consequence: trigger-only machinery must still be representable).

import { Edge, EdgeEnd, WorkflowDoc } from '../../../../shared/workflow/types'
import { PACK_PREFIX } from '../../../../shared/workflow/compose'

// ── Id ↔ owner mapping (the PACK_PREFIX inverse) ───────────────────────────────────────────────────

/** The owner of an effective-graph node id: `{ kind: 'narrator' }` for an unprefixed id, or
 *  `{ kind: 'pack', packId }` for a `pack:<packId>:<origId>` id. The packId is everything between
 *  the prefix and the LAST colon-delimited segment is NOT assumed — original fragment node ids never
 *  contain a colon (they are bare node ids), so `pack:<packId>:<origId>` splits into exactly the
 *  prefix, the packId, and the rest. We parse defensively: the packId is the segment(s) between the
 *  prefix and the FIRST following colon is wrong for packIds that themselves contain a colon (none do
 *  today — ids are `builtin.table-memory` etc., dot-separated), but to stay correct we take the packId
 *  from the composition meta instead where possible (ownerOfViaComposition). This string parse is the
 *  fallback when meta is absent. */
export type NodeOwner = { kind: 'narrator' } | { kind: 'pack'; packId: string }

/** Parse an effective-graph node id to its owner using ONLY the string shape. `pack:<packId>:<rest>`
 *  → pack owner (packId = the text between the prefix and the last `:`; original fragment ids carry
 *  no colon, so the last `:` is the packId↔origId separator). Anything without the prefix = narrator.
 *  Prefer ownerFromComposition when a composition map is available — it is authoritative. */
export function ownerOfNodeId(id: string): NodeOwner {
  if (!id.startsWith(PACK_PREFIX)) return { kind: 'narrator' }
  const rest = id.slice(PACK_PREFIX.length)
  const lastColon = rest.lastIndexOf(':')
  if (lastColon <= 0) return { kind: 'narrator' } // malformed — treat as narrator, never throw
  return { kind: 'pack', packId: rest.slice(0, lastColon) }
}

/** Build an authoritative id→packId map from the composition meta's `packs[packId].nodeIds` (the ids
 *  compose.ts actually stamped). Used to attribute every spliced node without re-parsing its id.
 *  Narrator nodes are simply absent from the map. */
export function nodeOwnerMap(composition: CompositionLike | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!composition) return map
  for (const [packId, pc] of Object.entries(composition.packs)) {
    for (const nodeId of pc.nodeIds) map.set(nodeId, packId)
  }
  return map
}

// ── meta.composition (read-only, structural mirror of compose.ts's shapes) ─────────────────────────
//
// We redeclare the minimal shape we consume rather than importing compose.ts's exported interfaces
// wholesale, to keep this module's surface to exactly what the projection needs (and because the
// IPC serializes the composition as plain JSON — the renderer sees data, not the classes).

export interface PackCompositionLike {
  nodeIds: string[]
  entries: { checkpoint: string; mode: 'branch' | 'inline' }[]
  rejoinEdges: { from: EdgeEnd; to: EdgeEnd; checkpoint: string }[]
}
export interface CompositionLike {
  packs: Record<string, PackCompositionLike>
}

/** Read `doc.meta.composition` back as our structural shape, or undefined when the doc carries none
 *  (the zero-packs effective graph IS the narrator — compose returns it untouched, no meta). */
export function readComposition(doc: WorkflowDoc): CompositionLike | undefined {
  const meta = doc.meta as { composition?: unknown } | undefined
  const comp = meta?.composition
  if (!comp || typeof comp !== 'object') return undefined
  const packs = (comp as { packs?: unknown }).packs
  if (!packs || typeof packs !== 'object') return undefined
  return comp as CompositionLike
}

// ── Splice-edge classification ─────────────────────────────────────────────────────────────────────
//
// A splice edge is an edge composition ADDED to plug a pack in — either an ENTRY edge (a checkpoint
// anchor's output → a pack node's input) or a REJOIN edge (a pack node's output → a checkpoint
// anchor's input). The canvas renders these DISTINCT (dashed) so the user sees where packs plug into
// the narrator. Rejoin edges are named authoritatively in `meta.composition.packs[*].rejoinEdges`.
// Entry edges are not separately recorded, so we classify by endpoints: an edge is a splice edge iff
// exactly ONE endpoint is a pack node and the OTHER is a narrator node (a cross-owner edge). Internal
// pack edges (both pack) and narrator edges (both narrator) are normal.

/** Whether `edge` crosses the narrator↔pack boundary (a splice edge — entry or rejoin). Uses the
 *  owner map (authoritative) with the id-string parse as the fallback for ids not in the map. */
export function isSpliceEdge(edge: Edge, owners: Map<string, string>): boolean {
  const fromPack = owners.has(edge.from.node) || ownerOfNodeId(edge.from.node).kind === 'pack'
  const toPack = owners.has(edge.to.node) || ownerOfNodeId(edge.to.node).kind === 'pack'
  return fromPack !== toPack
}

// ── Region grouping + layout ───────────────────────────────────────────────────────────────────────
//
// Each pack renders as a labeled REGION (a hull/frame around its spliced nodes). Composed docs carry
// no stored positions for spliced nodes RELATIVE to the narrator — a fragment's node positions come
// from its own coordinate space (the fragment authors lay it out around x≈2000+; see asyncMemoryPack
// positions), which would overlap or fly off next to the narrator's x≈40 spine. So we IGNORE the
// spliced nodes' own positions and lay each pack's region out programmatically, BELOW the narrator,
// one band per pack — deterministic, no auto-layout dependency (ADR 0010 layout consequence).

export interface RegionNodePos {
  id: string
  position: { x: number; y: number }
}

export interface PackRegion {
  packId: string
  /** The pack's spliced node ids in this projection (may be empty → trigger-only, see `detached`). */
  nodeIds: string[]
  /** True when the pack contributed NO spliced nodes (gate open but nothing survived composition —
   *  a trigger-only / headless-only pack). Rendered as a detached placeholder card. */
  detached: boolean
  /** The programmatic bounding band for this region (canvas coords), for the hull/header frame. */
  bounds: { x: number; y: number; width: number; height: number }
  /** Programmatic positions for THIS region's spliced nodes (overrides the fragment's own coords). */
  nodePositions: RegionNodePos[]
}

/** Layout constants — deliberately simple + deterministic (no dagre/elk). Regions stack vertically
 *  below the narrator; nodes within a region flow left-to-right, wrapping into rows. */
const REGION_TOP = 640 // below a typical narrator spine (its nodes sit near y≈40–560)
const REGION_GAP = 60 // vertical gap between stacked pack regions
const REGION_PAD = 28 // inner padding from the region frame to its nodes
const REGION_HEADER = 34 // header band height (the pack-name label sits here)
const NODE_W = 200
const NODE_H = 96
const NODE_HGAP = 48
const NODE_VGAP = 44
const NODES_PER_ROW = 6
const DETACHED_W = 260
const DETACHED_H = 96
const REGION_LEFT = 40

/** Lay out one pack's spliced nodes into a grid and compute the enclosing region band. `top` is the
 *  region's top edge. A `detached` (trigger-only) pack renders a compact placeholder region regardless
 *  of whether it has present-but-detached nodes (those float free; the placeholder is the affordance). */
function layoutRegion(packId: string, nodeIds: string[], top: number, detached: boolean): PackRegion {
  if (detached || nodeIds.length === 0) {
    // Detached (trigger-only) — a single placeholder card slot inside a compact region.
    return {
      packId,
      nodeIds,
      detached: true,
      bounds: {
        x: REGION_LEFT,
        y: top,
        width: DETACHED_W + REGION_PAD * 2,
        height: REGION_HEADER + DETACHED_H + REGION_PAD * 2
      },
      nodePositions: []
    }
  }
  const rows = Math.ceil(nodeIds.length / NODES_PER_ROW)
  const cols = Math.min(nodeIds.length, NODES_PER_ROW)
  const innerLeft = REGION_LEFT + REGION_PAD
  const innerTop = top + REGION_HEADER + REGION_PAD
  const nodePositions: RegionNodePos[] = nodeIds.map((id, i) => {
    const col = i % NODES_PER_ROW
    const row = Math.floor(i / NODES_PER_ROW)
    return {
      id,
      position: {
        x: innerLeft + col * (NODE_W + NODE_HGAP),
        y: innerTop + row * (NODE_H + NODE_VGAP)
      }
    }
  })
  const width = REGION_PAD * 2 + cols * NODE_W + (cols - 1) * NODE_HGAP
  const height = REGION_HEADER + REGION_PAD * 2 + rows * NODE_H + (rows - 1) * NODE_VGAP
  return {
    packId,
    nodeIds,
    detached: false,
    bounds: { x: REGION_LEFT, y: top, width, height },
    nodePositions
  }
}

/** One pack's placement input: its id + whether it is triggerOnly (renders detached). Mirrors the
 *  projection IPC's `packs[]` entries the caller passes through in order (already sorted, so a re-fetch
 *  keeps the same stacking). */
export interface PackPlacement {
  packId: string
  triggerOnly: boolean
}

/** Build every pack region from the composition meta, stacked deterministically below the narrator.
 *  `placements` fixes the stacking order. A triggerOnly pack (no spliced attachment) renders as a
 *  detached placeholder region even if it has present-but-detached nodes; a normally-spliced pack
 *  renders its node grid. A pack absent from the composition (empty nodeIds) is also detached. */
export function buildPackRegions(
  composition: CompositionLike | undefined,
  placements: PackPlacement[]
): PackRegion[] {
  const regions: PackRegion[] = []
  let top = REGION_TOP
  for (const { packId, triggerOnly } of placements) {
    const nodeIds = triggerOnly ? [] : (composition?.packs[packId]?.nodeIds ?? [])
    const region = layoutRegion(packId, nodeIds, top, triggerOnly)
    regions.push(region)
    top = region.bounds.y + region.bounds.height + REGION_GAP
  }
  return regions
}

/** Flatten every region's programmatic node positions into one id→position map — the canvas applies
 *  it to override each spliced node's own (fragment-space) coordinates. Narrator nodes are absent
 *  (they keep their stored positions). */
export function projectionNodePositions(regions: PackRegion[]): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>()
  for (const r of regions) for (const p of r.nodePositions) map.set(p.id, p.position)
  return map
}
