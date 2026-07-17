/**
 * Execution Record — the forensic journal of ONE generation (CONTEXT.md "Execution Record",
 * PLAN.md decision 13 / WP-1.1).
 *
 * It explains WHAT was sent to the provider — the ordered controlled transforms (marker
 * expansion, macro/template passes, prompt-regex, depth/injection insertion, role merging,
 * trimming, provider shaping) plus the exact wire messages — but it does NOT change what is
 * sent. Production is additive and behavior-neutral: `assemblePrompt` returns a record
 * alongside its unchanged `sendMessages`, and the two callers may ignore it.
 *
 * This module is PURE DATA (+ the narrow journal interface `buildPrompt` receives). It lives in
 * `src/shared` so the renderer can read a persisted record later (issue 08 preview reader) without
 * crossing the main boundary — hence it must not import from `main`/`renderer`. The concrete
 * builder that hashes bulk spans and assembles the record lives main-side
 * (`src/main/services/generation/executionRecord.ts`).
 *
 * Forensic only: it explains a past assembly, it does NOT promise deterministic re-execution
 * (no captured RNG / state snapshots — deferred until something needs it, PLAN decision 13).
 */

export const EXECUTION_RECORD_VERSION = 1

export type RecordRole = 'system' | 'user' | 'assistant'

/**
 * A message as it appears at a stage boundary. Structurally identical to main's `ChatMessage`
 * ({role, content}) — redeclared locally so this pure module never imports from `main`.
 */
export interface RecordMessage {
  role: RecordRole
  content: string
}

/**
 * How an entry carries its before/after payload:
 *  • `text` — the exact string, inline. Used for SMALL controlled transforms so their span
 *    lineage is legible (a preset block, a marker, a single injected line).
 *  • `ref` — a content hash + byte count (and an optional short preview), NOT the text itself.
 *    Used for BULK/history spans and opaque script mutations so the journal never duplicates
 *    large content (perf — PLAN risk 5). The authoritative copy lives once in `wire`.
 */
export type RecordContent =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; hash: string; bytes: number; preview?: string }

/**
 * What produced an entry. `id` is the STABLE source identity used to correlate across turns
 * (a preset block `identifier`, a lorebook entry `comment`, a marker token, or a pipeline-pass
 * name); `label` is an optional human-facing name.
 */
export interface RecordSource {
  kind:
    | 'preset-block'
    | 'lorebook-entry'
    | 'marker'
    | 'card-field'
    | 'persona'
    | 'memory'
    | 'history'
    | 'pipeline'
  id: string
  label?: string
}

/** The controlled-transform stages the assembler journals, in the order they can occur. */
export type RecordStage =
  | 'marker-expand' // a preset marker (char_description / world_info / …) resolved to content
  | 'macro' // a {{...}} macro pass over authored content
  | 'template' // EJS / ST-Prompt-Template evaluation (may carry opaque side effects)
  | 'regex' // prompt-time regex applied to a history/user turn
  | 'depth-inject' // a depth-positioned block spliced into the history region
  | 'marker-inject' // a [GENERATE:*] / @INJECT drain spliced into position
  | 'safety-net' // a headerless net insert (world-info net, mode addendum, persona net, tails)
  | 'trim' // fitToBudget dropped the oldest history turns
  | 'system-as-user' // system→user relabel (OpenAI-compatible path)
  | 'role-merge' // consecutive same-role messages coalesced
  | 'provider-shape' // orderForProvider reordering (end-on-user, etc.)
  | 'opaque' // arbitrary card/preset SCRIPT mutation — before/after hashes only, no copy

/** One ordered forensic entry. Controlled transforms carry span lineage (`before`/`after`
 *  as `text`); bulk and opaque ones carry `ref` hashes. `at`/`role` describe positional
 *  stages (insert / reorder / drop); `note` is an optional short human summary. */
export interface RecordEntry {
  seq: number
  stage: RecordStage
  source: RecordSource
  before?: RecordContent
  after?: RecordContent
  at?: number
  role?: RecordRole
  note?: string
}

export interface ExecutionRecordStats {
  entries: number
  /** Serialized JSON byte size of the whole record (measured overhead surfaces here). */
  bytes: number
  /** Wall-clock ms spent producing the wire messages + record inside the assembler. */
  buildMs: number
}

/** The complete record for one generation. */
export interface ExecutionRecord {
  version: number
  createdAt: string
  /** The ordered controlled-transform + decision journal. */
  entries: RecordEntry[]
  /** The exact wire messages the journal explains (the authoritative, un-hashed copy). */
  wire: RecordMessage[]
  stats: ExecutionRecordStats
}

/**
 * The narrow journal surface `buildPrompt` receives (optional — absent = today's behavior, no
 * record). Every method is a PURE observer: it reads the before/after values already in scope and
 * appends an entry; it never mutates the message array or affects control flow. The concrete
 * implementation (main-side) decides inline-vs-hash and does the hashing.
 */
export interface AssemblyJournal {
  /** A preset marker or card field expanded to `after` content. */
  marker(source: RecordSource, role: RecordRole, after: string): void
  /** A literal preset block transformed raw `before` → macro+EJS `after`. */
  literal(source: RecordSource, before: string, after: string): void
  /** Prompt-time regex changed a turn's text at `depth`. Only called when it actually changed. */
  regex(source: RecordSource, depth: number, before: string, after: string): void
  /** A depth-positioned block spliced into the history region at index `at`. */
  depthInject(source: RecordSource, depth: number, at: number, role: RecordRole, content: string): void
  /** A [GENERATE:*] / @INJECT marker entry drained into position `at`. */
  markerInject(source: RecordSource, at: number, role: RecordRole, content: string): void
  /** A headerless safety-net / tail insert (world-info net, mode addendum, persona, memory tail). */
  safetyNet(source: RecordSource, at: number, role: RecordRole, content: string): void
  /** The chat-history span was emitted (bulk — recorded by hash + turn count). */
  history(source: RecordSource, turnCount: number, joined: string): void
  /** An arbitrary card/preset SCRIPT mutation — before/after recorded as hashes only. */
  opaque(source: RecordSource, before: string, after: string): void
}
