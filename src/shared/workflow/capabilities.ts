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
 *    context.history / input.context          → reads-history
 *    llm.sample                               → calls-llm
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
  'llm.sample': 'calls-llm',
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
