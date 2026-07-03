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

// ── Triggers (WP2.1; ADR 0003/0004) ────────────────────────────────────────────────────────────
//
// A trigger attaches the fragment OFF the main path as a headless run (glossary: Headless Run): an
// execution started by a condition rather than a player action. This is the MODEL + VALIDATION half
// only — the evaluator and the runner are WP2.2. The three v1 trigger kinds (ADR 0004) are:
//
//   · state  — a declarative predicate over COMMITTED state (floor variables / table progress).
//   · cadence — fire every N floors (sugar over a state condition on the floor count; ADR 0004).
//   · manual  — fired by an explicit user action, no parameters.
//
// EVALUATION SEMANTICS (ADR 0004 — this is ABI, not a hint):
//   · Committed state ONLY. A trigger never sees an in-flight or later-rolled-back write; it reads
//     whatever is durably committed at the evaluation moment (ADR 0004 consequence 1).
//   · Commit boundaries ONLY. The runtime evaluates every installed pack's trigger at exactly two
//     moments — after a turn commits, and after a headless run commits (ADR 0004). There is NO
//     wall-clock/reactive evaluation. A per-chain DEPTH CAP (a runtime constant, WP2.2 — not
//     per-pack config) bounds trigger→run→trigger chains so two packs can't ping-pong forever
//     (ADR 0004 consequence 2).
//
// DELIBERATELY EXCLUDED from v1 (each is an additive future ABI change, never a breaking one — a new
// op, source scope, or trigger kind):
//   · Wall-clock schedules ("every 10 minutes while open") — rejected by ADR 0004 (local app that is
//     frequently closed; every motivating example is state-driven).
//   · Arbitrary expressions / EJS / boolean composition (AND/OR of predicates) — the master plan
//     (§Risks "The trigger predicate grammar") marks this the #1 scope-creep point: v1 is ONE
//     comparison op over ONE source, nothing richer. A pack needing conjunction declares two trigger
//     attachments (ADR 0009 allows several); OR-of-conditions is a future op-level change.
//   · Path wildcards / globs / array-scans in the vars path (see the path grammar below).
//
// STATE-CONDITION PATH GRAMMAR (v1):
//   A state condition names a `source` — a tagged pointer into committed state — and compares it:
//
//   { scope: 'vars', path }   Reads the LATEST committed floor's `variables` tree (floorService
//     `FloorFile.variables` — src/main/services/floorService.ts:44), which includes MVU's read-only
//     `stat_data` sub-tree plus any custom floor vars (varsNodes.ts:12-14, 68). `path` is a
//     DOT/BRACKET path resolved by the shared bracket-aware dialect (shared/objectPath.ts `toParts`/
//     `getPath` — the SAME parser MVU/stat_data reads use, objectPath.ts:5-21), e.g.
//     `stat_data.世界.当前时间`, `stat_data.hp`, `flags[0].done`, `date.month`.
//       Path rules (v1): one or more segments separated by `.`; a segment is either a bare key
//       (any non-empty run of non-`.`/`[`/`]` chars — CJK keys are real, varsNodes.ts) or a
//       `[index]` bracket segment (digits or a bare word, per objectPath.ts:24's `\[(\w+)\]`). NO
//       wildcards, NO `*`, NO trailing/leading/doubled `.`, NO empty `[]`. The path must be
//       non-empty. Validation checks WELL-FORMEDNESS, not existence (a missing path reads
//       undefined at eval time — the evaluator's concern, WP2.2).
//
//   { scope: 'table', table, stat }   Reads a per-table maintenance stat from the chat-level table
//     progress store. The stat set is CLOSED to the three numbers the store actually derives —
//     `TableProgress` in src/main/services/tableProgressService.ts:24-31:
//       · 'unprocessed' — floors not yet folded into the table (the "unsummarized backlog"; the
//         motivating trigger for the flagship async-memory pack, WP2.4 — tableProgressService.ts:29,51).
//       · 'processed'   — floors already folded in (tableProgressService.ts:26,49).
//       · 'nextExpected'— the floor index at which the table's cadence next fires
//         (tableProgressService.ts:28,50).
//     `table` is the template's sqlName (the key `getProgress` returns — tableProgressService.ts:58-64).
//     These are all NUMBERS, so table sources pair only with numeric comparisons.
//
// COMPARISON OPS (closed set — NO arbitrary expressions):
//   eq, ne, gt, gte, lt, lte  — standard comparisons; `value` is number | string | boolean. Numeric
//     ops require a numeric source/value at eval time (evaluator's concern); `eq`/`ne` also compare
//     strings/booleans (e.g. `stat_data.season eq 'winter'`).
//   changedBy  — a DELTA op, numeric only. It fires when `(currentValue − valueAtLastEvaluation) >=
//     value`, i.e. the source advanced by at least `value` SINCE THIS TRIGGER WAS LAST EVALUATED.
//     Well-defined precisely because evaluation happens only at commit boundaries (ADR 0004): the
//     runner (WP2.2) retains the last-evaluated numeric value per (chat, pack, trigger) and diffs it
//     on the next boundary. This is the "in-game time advanced >= 1 month" enabler (ADR 0003's
//     world-sim example). `value` MUST be a number and the source MUST be numeric; first-ever
//     evaluation has no prior value → the runner treats the baseline as the current value (no fire).

/** The two comparison-op families over a state source. `changedBy` is delta-since-last-evaluation
 *  (see the grammar block above); the rest are point comparisons. No arbitrary expressions v1. */
export const TRIGGER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'changedBy'] as const
export type TriggerOp = (typeof TRIGGER_OPS)[number]

/** The closed set of per-table maintenance stats a `table`-scoped source may address. Grounded in
 *  `TableProgress` (tableProgressService.ts:24-31) — the ONLY derived per-table numbers the store
 *  exposes. All three are numbers, so a table source pairs only with numeric comparisons. */
export const TABLE_STATS = ['unprocessed', 'processed', 'nextExpected'] as const
export type TableStat = (typeof TABLE_STATS)[number]

/** Whether `op` is one of the v1 comparison ops (narrowing to TriggerOp). */
export function isTriggerOp(op: string): op is TriggerOp {
  return (TRIGGER_OPS as readonly string[]).includes(op)
}

/** Whether `stat` is one of the v1 table stats (narrowing to TableStat). */
export function isTableStat(stat: string): stat is TableStat {
  return (TABLE_STATS as readonly string[]).includes(stat)
}

/** Whether `path` is a WELL-FORMED v1 vars path (see the path-grammar block above). Non-empty; one
 *  or more `.`-separated segments; each segment is a bare key (a non-empty run with no `.`/`[`/`]`)
 *  optionally followed by one or more `[index]` bracket accessors (digits or a bare word, matching
 *  objectPath.ts:24's `\[(\w+)\]`). NO wildcards, NO empty segments, NO empty `[]`, NO leading/
 *  trailing/doubled `.`. This checks SHAPE only — existence is the evaluator's concern (WP2.2). */
export function isWellFormedVarsPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false
  // A segment: a bare key (chars other than . [ ] *, so wildcards are rejected) then zero+ [word]
  // accessors. Anchored, no gaps — so `a..b`, `.a`, `a.`, `a[]`, `a.*.b` all fail.
  const segment = /^[^.[\]*]+(?:\[\w+\])*$/
  const parts = path.split('.')
  return parts.every((p) => segment.test(p))
}

/** A tagged pointer into committed state (see the path-grammar block above).
 *  - `vars`: a dot/bracket path into the latest committed floor's `variables` tree (incl. stat_data).
 *  - `table`: a closed per-table maintenance stat from the table-progress store. */
export type TriggerSource =
  | { scope: 'vars'; path: string }
  | { scope: 'table'; table: string; stat: TableStat }

/** A state-condition trigger: one comparison over one committed-state source. NOT composable in v1
 *  (a fragment declares several trigger attachments for AND — ADR 0009). */
export interface StateTrigger {
  kind: 'trigger'
  trigger: 'state'
  source: TriggerSource
  op: TriggerOp
  value: number | string | boolean
}

/** A cadence trigger: fire every N floors (N ≥ 1 integer). Sugar over a floor-count state condition
 *  (ADR 0004); the exact N is a System trigger param (glossary: System Setting). */
export interface CadenceTrigger {
  kind: 'trigger'
  trigger: 'cadence'
  everyNFloors: number
}

/** A manual trigger: fired by an explicit user action; no parameters. */
export interface ManualTrigger {
  kind: 'trigger'
  trigger: 'manual'
}

/** A trigger attaches the fragment off the main path as a headless run (glossary: Headless Run).
 *  Discriminated on `trigger` (state | cadence | manual). `kind: 'trigger'` keeps it inside the
 *  AttachmentDecl union (ADR 0009); the composition layer ignores every trigger regardless of shape
 *  (compose.ts checks only `att.kind === 'trigger'`). See ADR 0003/0004 and the grammar block above. */
export type TriggerAttachment = StateTrigger | CadenceTrigger | ManualTrigger

/** One attachment a fragment declares. A fragment may declare several (ADR 0009). */
export type AttachmentDecl = EntryAttachment | RejoinAttachment | TriggerAttachment
