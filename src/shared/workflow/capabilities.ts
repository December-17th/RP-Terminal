// Derived capabilities: what a pack's fragment can READ / WRITE / RUN, computed mechanically from
// its node types + attachment shapes. This is the DISPLAY-GRADE derivation the Agents workspace
// shows on each pack card (agent-packs plan WP3.1); the SOUNDNESS half — denial enforcement, the
// "a write node reachable through a path the analysis missed is a security hole" guarantee
// (ADR 0007) — is HARDENED in phase 4 (`shared/workflow/capabilities.ts` gains denial-soundness
// tests + becomes the enforcement authority, master plan §Phase 4). Keep this table in lockstep
// with ADR 0007's mechanical mapping; phase 4 extends, it must not contradict.
//
// Decisions: ADR 0007 (capabilities are derived mechanically from node types + edges, NEVER trusted
// from creator declarations — "injects prompt context" derives from a rejoin at prompt-assembly and
// "runs headless" from a declared trigger, not from node types). Glossary: root CONTEXT.md (Derived
// Capability). Pure: imports only the shared graph types + attachment shapes; no I/O, safe from
// main, renderer, preload, and tests.

import { WorkflowDoc } from './types'
import { AttachmentDecl } from './attachments'

/** The closed set of v1 capability ids (ADR 0007's mechanical table). Node-type-derived capabilities
 *  plus the two structure-derived ones (injects-prompt from a rejoin, runs-headless from a trigger).
 *  A new node type or attachment kind extends this additively — it never silently broadens an
 *  existing id. */
export const CAPABILITY_IDS = [
  'reads-tables',
  'writes-tables',
  'reads-vars',
  'writes-vars',
  'reads-lorebooks',
  'reads-history',
  'calls-llm',
  'writes-floors',
  'runs-game-tools',
  'injects-prompt',
  'runs-headless'
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** The WRITE capabilities — the ones the UI danger-tints (a pack that can MUTATE durable state is
 *  the one a user weighs before enabling; reads are benign). Kept here (not in the renderer) so the
 *  read/write split is one authority, shared by display + the phase-4 denial work. */
export const WRITE_CAPABILITIES: readonly CapabilityId[] = [
  'writes-tables',
  'writes-vars',
  'writes-floors'
] as const

/** Whether `id` is a write capability (danger-tinted chip). */
export function isWriteCapability(id: CapabilityId): boolean {
  return (WRITE_CAPABILITIES as readonly string[]).includes(id)
}

/** Node type → the capability it confers (ADR 0007's mechanical table). A type absent from this map
 *  confers NO capability (unknown / capability-neutral node types are ignored — util.log, prompt.*,
 *  context.refresh/trimProcessed, subgraph.*, control.*, etc.). This is the SINGLE place the
 *  node-type mapping lives; phase 4's enforcement reads the same table.
 *
 *  Mapping (from the WP3.1 brief + ADR 0007):
 *    table.read / table.query / table.export  → reads-tables
 *    table.apply                              → writes-tables
 *    vars.get                                 → reads-vars
 *    vars.save / mvu.set / apply.state        → writes-vars
 *    lorebook.select / lorebook.entries / tool.lorebookSearch → reads-lorebooks
 *    context.history / input.context / history.recent → reads-history
 *    llm.sample / agent.llm                   → calls-llm
 *    output.writeFloor                        → writes-floors
 *    tool.startCombat / tool.startDuel        → runs-game-tools */
const NODE_TYPE_CAPABILITY: Readonly<Record<string, CapabilityId>> = {
  'table.read': 'reads-tables',
  'table.query': 'reads-tables',
  'table.export': 'reads-tables',
  'table.apply': 'writes-tables',
  'vars.get': 'reads-vars',
  'vars.save': 'writes-vars',
  'mvu.set': 'writes-vars',
  'apply.state': 'writes-vars',
  'lorebook.select': 'reads-lorebooks',
  'lorebook.entries': 'reads-lorebooks',
  'tool.lorebookSearch': 'reads-lorebooks',
  'context.history': 'reads-history',
  'input.context': 'reads-history',
  // One-canvas rebuild WP6.2 (ADR 0011) consolidated agent nodes:
  //  · history.recent reads the committed chat history (the consolidated context.history).
  //  · agent.llm makes one model call (the consolidated llm.sample) — a calls-llm node.
  'history.recent': 'reads-history',
  'llm.sample': 'calls-llm',
  'agent.llm': 'calls-llm',
  'output.writeFloor': 'writes-floors',
  'tool.startCombat': 'runs-game-tools',
  'tool.startDuel': 'runs-game-tools'
}

/** The capability a single node type confers, or undefined if it is capability-neutral / unknown
 *  (ADR 0007: unknown types are ignored, never treated as a broad grant). Exported for tests. */
export function capabilityOfNodeType(nodeType: string): CapabilityId | undefined {
  return NODE_TYPE_CAPABILITY[nodeType]
}

/** The two STRUCTURE-derived capabilities (ADR 0007 — NOT node-type-derived):
 *   · injects-prompt — the fragment contributes a value back at the prompt-assembly checkpoint (any
 *     `rejoin` attachment naming `prompt-assembly`); it puts content into the next prompt.
 *   · runs-headless — the fragment declares any `trigger` attachment, so it can run on its own
 *     outside a turn.
 *  Derived from attachments, never from node types. Exported for tests. */
export function structuralCapabilities(attachments: readonly AttachmentDecl[]): CapabilityId[] {
  const out: CapabilityId[] = []
  if (attachments.some((a) => a.kind === 'rejoin' && a.checkpoint === 'prompt-assembly'))
    out.push('injects-prompt')
  if (attachments.some((a) => a.kind === 'trigger')) out.push('runs-headless')
  return out
}

/** Derive every capability a fragment exposes: map its node types through the mechanical table, add
 *  the structure-derived pair, and return the DISTINCT ids in CAPABILITY_IDS order (stable for a
 *  deterministic chip row). A fragment with no capability-conferring nodes and no rejoin/trigger
 *  returns []. Pure over the doc's `nodes` + `attachments` — no reachability yet (that is phase 4's
 *  denial-soundness work; display shows the full surface, which is a superset — safe). */
export function deriveCapabilities(doc: WorkflowDoc): CapabilityId[] {
  const present = new Set<CapabilityId>()
  for (const node of doc.nodes) {
    const cap = NODE_TYPE_CAPABILITY[node.type]
    if (cap) present.add(cap)
  }
  for (const cap of structuralCapabilities(doc.attachments ?? [])) present.add(cap)
  // Return in CAPABILITY_IDS order so the chip row is deterministic regardless of node order.
  return CAPABILITY_IDS.filter((id) => present.has(id))
}

// ── Enforcement-grade derivation (WP4.1; ADR 0007) ───────────────────────────────────────────────
//
// `deriveCapabilities` above is the DISPLAY reduction (just the chip ids). Enforcement (import
// verification + denial gating) needs more, and it needs SOUNDNESS: a node type this analysis has
// never seen must SURFACE, not silently derive zero capabilities — "a write node reachable through a
// path the analysis missed is a security hole" (ADR 0007 consequences). So the enforcement entrypoint
// takes the set of node types the runtime actually KNOWS (the builtin registry's keys, passed in so
// this stays pure/main-free) and reports any node whose type is neither capability-mapped NOR in that
// known set as an `unknownNodeType`. The soundness TEST (test/workflow/capabilitySoundness.test.ts)
// enumerates the registry and asserts every known type is mapped OR in a justified inert ALLOWLIST —
// so a newly-registered type with no mapping and no allowlist entry fails CI, which is the point.

/** The genuinely capability-INERT builtin node types: known to the runtime, deliberately conferring
 *  NO read/write/run capability. This is the soundness escape hatch — every entry is a node that
 *  moves data or controls flow WITHOUT touching durable state, calling the model, or running a game
 *  tool. A new node type is inert ONLY if it belongs here with a justification; otherwise it must map
 *  to a capability in NODE_TYPE_CAPABILITY. The soundness test enforces: every registered type is in
 *  exactly one of {NODE_TYPE_CAPABILITY, this set}.
 *
 *  Justifications (each is pure data-plumbing / control-flow, no durable side effect, no LLM, no tool):
 *   · input.context        — assembles the in-memory turn Context; reads nothing durable itself
 *                            (history reads are the dedicated context.history/input.context READ cap —
 *                            input.context is the turn seed, see note below).
 *   · context.refresh      — re-derives the Context in place; no state read/write.
 *   · context.card         — projects the already-loaded character card into Context; no durable read.
 *   · context.persona      — projects the already-loaded persona into Context; no durable read.
 *   · context.action       — reads the user's just-typed action off the Context; not durable state.
 *   · context.params       — extracts gen params off the Context; pure projection.
 *   · context.trimProcessed— trims already-processed floors from the in-memory Context window.
 *   · prompt.assemble      — assembles the outgoing prompt text; the injects-prompt capability is
 *                            STRUCTURE-derived (a rejoin at prompt-assembly), never node-derived.
 *   · prompt.messages      — builds a Messages array from inputs; pure shaping.
 *   · prompt.preset        — composes a preset's blocks into the prompt; pure shaping.
 *   · merge.messages       — concatenates Messages arrays; pure.
 *   · messages.trim        — drops messages to fit a budget; pure.
 *   · text.template        — renders an inline template string; pure (no state, no eval of durable data).
 *   · parse.response       — splits an LLM reply into fields; operates on in-memory text.
 *   · parse.extract        — extracts a value from text via a rule; pure.
 *   · control.if / control.switch / control.when — flow control; route Signals, touch no state.
 *   · util.log             — diagnostic logging; no state effect.
 *   · table.gate           — a pure predicate gate over a table read result (routes a Signal); it
 *                            does NOT itself read/write the table — the upstream table.read/query
 *                            carries reads-tables, so gating alone confers nothing.
 *   · subgraph.input / subgraph.output — sub-graph boundary markers; carry no capability of their own.
 *                            A subgraph.call's capabilities come from the NODES INSIDE the called doc
 *                            (analyzed when that doc is derived); the boundary nodes are plumbing.
 *   · subgraph.call        — invokes a nested doc. Its capabilities are those of the nested doc's
 *                            nodes; at THIS doc's level the call node itself confers none. (Deep
 *                            cross-doc reachability is a later WP; flagged in the WP4.1 report.)
 *   · subgraph.loop        — repeats a nested doc; same reasoning as subgraph.call.
 *   · trigger.state / trigger.cadence / trigger.manual — agent-chain ROOTS (one-canvas rebuild WP6.1;
 *                            ADR 0011). A trigger node's run() only fires a Signal; it touches NO
 *                            durable state. The trigger's condition is EVALUATED by the headless
 *                            evaluator against committed state, but that is the evaluator's read, not
 *                            the node's — the node itself is pure plumbing that starts a chain, and the
 *                            chain's real capabilities come from its downstream nodes (agent/parser/SQL).
 *
 *  NOTE (input.context): it appears in BOTH tables — mapped to `reads-history` in NODE_TYPE_CAPABILITY
 *  (it seeds the turn from chat history) AND could be argued inert. The MAPPING wins (a type in
 *  NODE_TYPE_CAPABILITY is never treated as inert); it is NOT listed here. Kept out of this set to
 *  preserve the "exactly one table" invariant the soundness test checks. */
export const INERT_NODE_TYPES: ReadonlySet<string> = new Set([
  'context.refresh',
  'context.card',
  'context.persona',
  'context.action',
  'context.params',
  'context.trimProcessed',
  'prompt.assemble',
  'prompt.messages',
  'prompt.preset',
  'merge.messages',
  'messages.trim',
  'text.template',
  'parse.response',
  'parse.extract',
  'control.if',
  'control.switch',
  'control.when',
  'util.log',
  'table.gate',
  'subgraph.input',
  'subgraph.output',
  'subgraph.call',
  'subgraph.loop',
  'trigger.state',
  'trigger.cadence',
  'trigger.manual'
])

/** The enforcement-grade capability report for a fragment (ADR 0007). Beyond the display chip list it
 *  carries:
 *   · `unknownNodeTypes` — node types present in the doc that are NEITHER capability-mapped NOR in
 *     `knownTypes` (the runtime's registered set). A non-empty list means the analysis cannot vouch
 *     for those nodes → import verification must treat the pack as UNSOUND (reject / warn hard), never
 *     silently grant zero capabilities. THIS is the soundness guarantee.
 *   · `nodesByCapability` — for each derived capability id, the node ids that conferred it, so the
 *     import screen can show "which nodes need table writes" and denial can target the right sub-paths
 *     (ADR 0007 denial closes the entry edges of the paths that reach these nodes).
 *
 *  Note: this is still a per-node/per-attachment SURFACE analysis (a superset — safe for display and
 *  for conservative denial). Edge-reachability pruning (denying a cap only severs the paths that
 *  actually reach it) is the denial-gating WP; the report already exposes the node→cap map it needs. */
export interface CapabilityReport {
  capabilities: CapabilityId[]
  unknownNodeTypes: string[]
  nodesByCapability: Partial<Record<CapabilityId, string[]>>
}

/** Derive the enforcement-grade capability report for `doc`, given `knownTypes` — the node types the
 *  runtime recognizes (pass `new Set(builtinRegistry.descriptors().keys())` from main/tests; kept a
 *  parameter so this module stays pure). A node whose type is capability-mapped contributes its cap
 *  (and its id to `nodesByCapability`); a node whose type is unmapped BUT in `knownTypes` is inert
 *  (contributes nothing — it is deliberately capability-neutral, e.g. control.*); a node whose type is
 *  in NEITHER surfaces in `unknownNodeTypes` (soundness — never silently zero). Structural caps
 *  (injects-prompt / runs-headless) are added from attachments and have no conferring node, so they
 *  do not appear in `nodesByCapability`. */
export function deriveCapabilityReport(
  doc: WorkflowDoc,
  knownTypes: ReadonlySet<string>
): CapabilityReport {
  const present = new Set<CapabilityId>()
  const nodesByCapability: Partial<Record<CapabilityId, string[]>> = {}
  const unknown = new Set<string>()

  for (const node of doc.nodes) {
    const cap = NODE_TYPE_CAPABILITY[node.type]
    if (cap) {
      present.add(cap)
      ;(nodesByCapability[cap] ??= []).push(node.id)
      continue
    }
    // Unmapped: inert IF the runtime knows the type; otherwise SURFACE it (soundness — ADR 0007).
    if (!knownTypes.has(node.type)) unknown.add(node.type)
  }

  for (const cap of structuralCapabilities(doc.attachments ?? [])) present.add(cap)

  return {
    // CAPABILITY_IDS order for a deterministic chip row (matches deriveCapabilities).
    capabilities: CAPABILITY_IDS.filter((id) => present.has(id)),
    // Sorted for a stable, diffable report regardless of node order.
    unknownNodeTypes: [...unknown].sort(),
    nodesByCapability
  }
}
