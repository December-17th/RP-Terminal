// Pure graph model for the node workflow engine (spec §4). No I/O; safe to import from
// main, renderer, preload, and tests. See docs/superpowers/specs/2026-07-01-node-workflow-engine-design.md.
import type { AttachmentDecl } from './attachments'

export const PORT_TYPES = [
  'Messages',
  'Text',
  'Vars',
  'Floors',
  'Context',
  // A `Lorebook[]` on the wire (per-call lorebook subsets — context-epochs plan §2).
  'Lore',
  'Signal',
  'Error',
  'Any'
] as const

export type PortType = (typeof PORT_TYPES)[number]

export interface PortSpec {
  name: string
  type: PortType
}

/** The pure, side-effect-free description of a node type: its ports and metadata.
 *  Main pairs each descriptor with a `run()` implementation (Phase 2); validation uses only this. */
export interface NodeDescriptor {
  type: string
  title: string
  inputs: PortSpec[]
  outputs: PortSpec[]
  isMainOutputCapable?: boolean
  /** One-canvas rebuild (WP6.1; ADR 0011): this node type is a TRIGGER root — it starts an agent
   *  chain and is EXCLUDED from turn execution (the engine seeds its outgoing edges dead so its
   *  downstream chain is pruned). Kept a generic descriptor flag (not a hardcoded `trigger.*` list in
   *  the engine) so the executor stays type-agnostic and any future trigger kind opts in by setting
   *  it. Trigger nodes fire only headlessly (headlessRunService's doc-driven path). */
  isTrigger?: boolean
}

export interface NodeInstance {
  id: string
  type: string
  config?: Record<string, unknown>
  position?: { x: number; y: number }
  panel?: { show: boolean; label?: string; collapsed?: boolean }
  isMainOutput?: boolean
  /** One-canvas rebuild (WP6.1; ADR 0011): a disabled node never runs — it traces 'skipped' and its
   *  outgoing edges are dead (existing dead-edge semantics), so its exclusive downstream chain is
   *  pruned. A disabled TRIGGER additionally never fires headlessly (the agent's off-switch). Absent =
   *  enabled (every pre-WP6.1 doc). Disabling is always legal at the doc level; the one caller-facing
   *  consequence is a disabled main-output node — see runWorkflow, which surfaces it as a run failure
   *  rather than undefined behavior. */
  disabled?: boolean
}

export interface EdgeEnd {
  node: string
  port: string
}

export interface Edge {
  from: EdgeEnd
  to: EdgeEnd
}

/** One-canvas rebuild (WP6.3): a single member setting a GroupDecl surfaces on its collapsed
 *  module panel. `path` is a top-level config field key (v1 exposes only top-level schema fields;
 *  nested paths are not exposable) resolved with the shared objectPath dialect. A stale path (the
 *  field renamed/removed) renders empty in the panel — same skip-with-log stance as
 *  materializeFragment; it is deliberately NOT validated. */
export interface ExposedGroupSetting {
  node: string
  path: string
  label: string
}

/** One-canvas rebuild (WP6.3): DOC METADATA grouping in-place nodes into a "module" on the canvas.
 *  Nothing moves; no subgraph extraction, no new doc kind. A node belongs to at most ONE group;
 *  groups contain nodes only (no nested groups). `id` is minted `group-<n>` like addNode ids. */
export interface GroupDecl {
  id: string
  name: string
  /** ≥2 member node ids; each must be a node in doc.nodes (validate: GROUP_MEMBER_MISSING) and in
   *  no other group (GROUP_OVERLAP). */
  nodeIds: string[]
  /** Persisted presentation state: true = shown as a single collapsed module node. */
  collapsed?: boolean
  /** Member settings promoted onto the collapsed module panel. Each entry's `node` must be a member
   *  (validate: GROUP_EXPOSED_NOT_MEMBER). */
  exposed?: ExposedGroupSetting[]
}

export interface WorkflowDoc {
  id: string
  name: string
  version: number
  schemaVersion: number
  description?: string
  nodes: NodeInstance[]
  edges: Edge[]
  /** One-canvas rebuild (WP6.3): on-canvas module groupings over in-place nodes. Absent = no
   *  groups. Pure doc metadata — the engine ignores it entirely. */
  groups?: GroupDecl[]
  meta?: Record<string, unknown>
  /** Absent = 'turn' (a normal generation graph, run by runWorkflow/resolveWorkflowDoc). A
   *  'subgraph' doc is a reusable sub-graph package (sub-graph nodes v1 plan §1/§2): it's never
   *  run directly (resolveWorkflowDoc falls through past it) and skips the exactly-one-main-
   *  output rule — it's invoked only by wrapping it in a `subgraph.call` node. A 'fragment' doc is
   *  an agent pack's executable part (agent-packs plan WP1.1; spec §Runtime Model; ADR 0002/0009):
   *  like a subgraph it is never run alone and skips the main-output rule, but it additionally
   *  declares `attachments` — the checkpoints it enters/rejoins and any headless triggers. */
  kind?: 'turn' | 'subgraph' | 'fragment'
  /** Only meaningful when `kind === 'fragment'`: the attachments this fragment declares (≥1
   *  required for a fragment; ADR 0009 — one pack, one graph, many attachments). Ignored for
   *  'turn'/'subgraph' docs. See ./attachments.ts for the AttachmentDecl shape. */
  attachments?: AttachmentDecl[]
}

/** Whether an output port of type `from` may connect to an input port of type `to`.
 *  `Any` is a wildcard both ways, EXCEPT into a `Signal` input: the engine's gating counts only
 *  edges whose SOURCE port type is Signal, so an Any→Signal wire would validate yet gate nothing
 *  — silently useless, so it's rejected. Otherwise types must match exactly (spec §4). */
export function portCompatible(from: PortType, to: PortType): boolean {
  if (to === 'Signal') return from === 'Signal'
  if (from === 'Any' || to === 'Any') return true
  return from === to
}
