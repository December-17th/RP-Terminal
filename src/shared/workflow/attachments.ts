// The checkpoint id vocabulary and the attachment declarations a fragment makes against it.
//
// This is the PortType-free half of the agent-pack ABI: the names and the attachment shapes only.
// The value type at each checkpoint (which needs PortType from ./types) lives in ./checkpoints.ts.
// The split keeps ./types.ts (WorkflowDoc.attachments) able to import these without pulling in
// PortType-dependent code, so there is no import cycle (types → attachments, checkpoints → both).
//
// Spec: docs/superpowers/specs/2026-07-03-agent-pack-workflow-ux-design-revision-3.md §Runtime
// Model ("The v1 checkpoint vocabulary (frozen at four)"). Decisions: ADR 0002 (fragments attach
// at checkpoints; disabling gates the entry edge) and ADR 0009 (one pack, one graph, many
// attachments). Glossary: root CONTEXT.md (Checkpoint, Attachment Point, Branch/Inline Fragment,
// Trigger). Pure: no imports — safe from main, renderer, preload, and tests.

/** The four v1 checkpoints, in main-path order. This tuple is the compatibility surface packs
 *  depend on: changing a name breaks packs, so the vocabulary is versioned and grown deliberately
 *  (ADR 0002 consequences; spec §Runtime Model "Every checkpoint added is a compatibility
 *  promise"). No fifth checkpoint until a real pack is blocked without it. */
export const CHECKPOINT_IDS = [
  'context-ready',
  'prompt-assembly',
  'reply-parsed',
  'turn-committed'
] as const

export type CheckpointId = (typeof CHECKPOINT_IDS)[number]

/** Whether `id` names a known v1 checkpoint (narrowing to CheckpointId). */
export function isCheckpointId(id: string): id is CheckpointId {
  return (CHECKPOINT_IDS as readonly string[]).includes(id)
}

// ── Attachments (ADR 0009: one pack, one graph, many attachments) ──────────────────────────────
//
// A fragment declares one or more attachments — where and how it joins the turn. Entry/rejoin
// attachments land on named checkpoints (ADR 0002); a trigger attaches the fragment off the main
// path as a headless run (glossary: Headless Run).

/** Names one port on one of a fragment's own nodes. This is how an attachment designates WHICH of
 *  the fragment's internal nodes/ports the checkpoint value enters or leaves through (WP1.2
 *  composition boundary). Subgraph docs mark their boundary ports with dedicated
 *  `subgraph.input`/`subgraph.output` NODES carrying a `slot` config
 *  (src/main/services/nodes/builtin/subgraphNodes.ts:53-94); that convention cannot be reused
 *  verbatim here — those node types are validation-forbidden outside a `kind:'subgraph'` doc
 *  (validate.ts BOUNDARY_IN_TURN, which fires for a fragment). So a fragment names its boundary
 *  port inline on the attachment instead — the minimal convention that needs no new node types and
 *  keeps the designation next to the attachment it belongs to. */
export interface FragmentPortRef {
  /** A node id INSIDE the fragment doc (its un-prefixed id; composition prefixes it later). */
  node: string
  /** The port name on that node (an input port for an entry sink / rejoin source not applicable —
   *  see EntryAttachment.entryPort / RejoinAttachment.rejoinPort for which direction each is). */
  port: string
}

/** A fragment enters the turn at `checkpoint`.
 *  - `branch` (default): the main flow does not depend on it; failure/disablement never blocks the
 *    reply (glossary: Branch Fragment).
 *  - `inline`: the main message flow is wired THROUGH the fragment; downstream depends on its
 *    output, so its output must be type-compatible with the checkpoint's value type, and disabling
 *    it gates the reply (glossary: Inline Fragment). */
export interface EntryAttachment {
  kind: 'entry'
  checkpoint: CheckpointId
  mode: 'branch' | 'inline'
  /** The fragment's own INPUT port that receives the checkpoint value (WP1.2 composition). The
   *  checkpoint's value source (the anchor's output, e.g. `input.context.gen`) is wired INTO this
   *  input. Optional at the declaration level (WP1.1 validation ignores it); an entry without it
   *  cannot be spliced and composition skips it with a warning. */
  entryPort?: FragmentPortRef
  /** INLINE ONLY: the fragment's own OUTPUT port whose value replaces the checkpoint value on the
   *  main flow. Inline mode re-routes the main-flow edge THROUGH the fragment: the anchor's
   *  upstream feeds `entryPort`, and this `outPort` feeds whatever the anchor value fed downstream
   *  (ADR 0002 — inline transforms the main flow). Ignored for branch entries. */
  outPort?: FragmentPortRef
}

/** A fragment contributes a value back at `checkpoint` (e.g. a prompt-injection block at
 *  `prompt-assembly`). The rejoin's contributed value type must match the checkpoint's value type;
 *  that type-check is enforced against inline-entry outputs during composition (WP1.2) — at the
 *  declaration level a rejoin only needs to name a known checkpoint (glossary: Attachment Point). */
export interface RejoinAttachment {
  kind: 'rejoin'
  checkpoint: CheckpointId
  /** The fragment's own OUTPUT port that produces the value contributed back at `checkpoint`
   *  (WP1.2 composition). This output is wired INTO the checkpoint anchor's input (e.g.
   *  `prompt.assemble.block`). Optional at the declaration level; a rejoin without it cannot be
   *  spliced and composition skips it with a warning. */
  rejoinPort?: FragmentPortRef
  /** WP1.6b: selects WHICH of the checkpoint's anchor LANES this rejoin lands on, by the lane's
   *  port name (checkpoints.ts CheckpointAnchor.port — for `prompt-assembly`: `'block'`, the plain
   *  text tail, or `'entries'`, the placement-carrying LorebookEntry[] lane). Absent = the
   *  checkpoint's DEFAULT lane (anchors[0], i.e. `block` for prompt-assembly), so every pre-WP1.6b
   *  rejoin keeps its exact behavior. An unknown name is a validation error (UNKNOWN_ANCHOR) and,
   *  defensively, a compose-time 'unknown-anchor-port' skip-with-warning. */
  anchor?: string
}

/** STUB (WP1.1): a trigger attaches the fragment off the main path as a headless run. Its full
 *  condition shape — state condition / cadence / manual — arrives in WP2.1 (`TriggerDecl`). See
 *  ADR 0003 (headless runs and triggers) and ADR 0004; glossary: Trigger, Headless Run. Do NOT add
 *  the condition fields here ad hoc; the grammar is a deliberate later WP. */
export interface TriggerAttachment {
  kind: 'trigger'
}

/** One attachment a fragment declares. A fragment may declare several (ADR 0009). */
export type AttachmentDecl = EntryAttachment | RejoinAttachment | TriggerAttachment
