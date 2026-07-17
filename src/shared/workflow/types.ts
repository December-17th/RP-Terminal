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
  // The rich assembly ARTIFACT on the wire (issue 18a / PLAN.md decision 11): authored prompt
  // CONTRIBUTIONS + the resolved wire messages + the forensic execution record + sampler params,
  // as ONE port type (not one per assembly phase — keeping the prompt module deep). Its value shape
  // is `PromptArtifact` (src/main/services/nodes/promptArtifact.ts, main-side — the engine treats a
  // port value as `unknown`). Legacy `Messages` producers wrap as an artifact with synthetic
  // provenance; a final adapter re-exposes `ChatMessage[]` to any node that still requires it.
  'Prompt',
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
  /** Agent & memory UX (WP-A; spec §1): the config field name(s) that hold an authored PROMPT — a
   *  role-message array (`agent.llm.messages`) or a template string (`text.template.template`). Surfaced
   *  through `list-node-types` so the editor routes these fields to the dedicated Prompt editor instead
   *  of the generic schema-form control, and derives the on-card prompt excerpt. Pure UI hint — the
   *  engine ignores it. An imported agent inherits this from its built-in node types (no author work). */
  promptFields?: string[]
  /** Agent & memory UX (WP-A; plan §0.5): describes an enum config field whose options are NOT a
   *  static zod enum but live in a sibling config array (the `control.mode.selected ⇐ options[].key`
   *  case, stamped in WP-B). The generic exposed-enum renderer prefers a static JSON-Schema `enum`,
   *  falling back to resolving this against the node's current config. Pure UI hint. */
  dynamicEnum?: DynamicEnumHint
}

/** Agent & memory UX (WP-A; plan §0.5): points the exposed-enum renderer at an enum field whose
 *  option set is data (a sibling config array) rather than a static schema enum. All four are config
 *  paths / field names resolved against the node instance's current config. */
export interface DynamicEnumHint {
  /** The enum field's config path (e.g. `'selected'`). */
  path: string
  /** The config path of the options array (e.g. `'options'`). */
  optionsPath: string
  /** The option object's key field — the stored value (e.g. `'key'`). */
  keyField: string
  /** The option object's label field — the display text (e.g. `'label'`). */
  labelField: string
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
  /** Agent & memory UX (WP-A; spec §1): OPTIONAL author-written setup guidance, rendered verbatim in a
   *  warning tint on the agent panel (e.g. "needs a bound table template + an API preset"). Plain
   *  string, never interpreted. Round-trips through the doc AND the `.rptmodule` envelope. */
  note?: string
  /** Agent & memory UX (WP-A; spec §5, plan risk 5): OPTIONAL provenance. `'import'` marks a group that
   *  arrived via a `.rptmodule` import — the Agents ▾ dropdown shows an `imported` chip. Stamped by the
   *  importer at insert time (WP-F), NOT carried in the module envelope. Absent = authored in place. */
  origin?: 'import'
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
