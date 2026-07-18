// Pure section-shaping for the next-prompt injection preview (agent-packs plan WP3.4; issue 08 —
// "preview becomes a reader of the execution record"). Given the forensic Execution Record the
// assembler produced (issue 07), the composition metadata (which pack fed which prompt-assembly lane
// — ADR 0002 attribution-by-construction), and the engine's node outputs (the exact pack rejoin
// values), decompose the assembly into attributed sections + an omitted list. Side-effect-free +
// main/renderer-free imports so it is unit-testable directly under Node
// (test/generation/previewSections.test.ts); the preview SERVICE (previewService.ts) does the engine
// run, captures the record, and calls this to shape the result.
//
// GROUNDING — this reads the RECORD, it does NOT guess by content. The old shaper classified a FLAT
// `ChatMessage[]` by content prefix (`World Info:\n`, `Example dialogue:\n`, `Name: `), a persona
// regex, and substring/exact-text matching — a heuristic that could not tell a pack's world-info from
// the card's, nor decompose a merged system block. The Execution Record removes the guessing: every
// controlled transform is journaled with its REAL source identity (a card field, a preset block's
// `identifier`, a persona/memory marker, a lorebook entry, the history span) at the moment it placed
// its text (`src/shared/executionRecord.ts`; the journal call sites in `promptBuilder.ts`). So a
// section's kind + source is the entry's OWN `source`, not a content sniff. Bulk history is hashed in
// the record (perf) so its per-turn text is read from `record.wire` (the authoritative wire copy),
// still without content matching — the turns are the wire's non-system messages, the pending action is
// the last user turn. Pack attribution stays by-construction: a pack that rejoined the `entries` lane
// merged into the top-level World Info block, one that rejoined the `block` lane merged into the memory
// tail — the composition meta names the lane, so the matching narrator section is re-attributed to the
// pack WITHOUT scanning its text.

import { createHash } from 'node:crypto'
import type { CompositionMeta } from '../../../shared/workflow/compose'
import type { CheckpointId } from '../../../shared/workflow/attachments'
import type {
  ExecutionRecord,
  RecordContent,
  RecordEntry,
  RecordMessage,
  RecordSource
} from '../../../shared/executionRecord'

/** Where a section's text came from. `narrator` = the base workflow's own assembly (card / persona /
 *  world-info / history / preset / memory). `pack` = a gate-open pack's prompt-assembly rejoin
 *  (packId + name). `lorebook`/`memory` are reserved for future finer attribution. */
export interface SectionSource {
  kind: 'narrator' | 'pack' | 'lorebook' | 'memory'
  packId?: string
  name?: string
}

/** A localizable section-kind id. The renderer maps `preview.section.<id>` to a label; `id` is stable
 *  and enumerable (unit tests assert on it). */
export type SectionKind =
  | 'system'
  | 'persona'
  | 'card'
  | 'worldInfo'
  | 'history'
  | 'memory'
  | 'packInject'
  | 'action'
  | 'other'

export interface PreviewSection {
  /** Section-kind id (localizable via `preview.section.<id>`). */
  id: SectionKind
  /** The same kind id doubled as a label key hint (the renderer localizes; kept for symmetry with the
   *  spec's { id, label } shape). */
  label: string
  source: SectionSource
  /** Estimated token count for this section's text (see estimate note on the service). */
  tokens: number
  /** True — token counts are ESTIMATED (char-based heuristic; the app has no real tokenizer). */
  estimated: boolean
  /** The full section text (for the renderer's per-section expand). */
  text: string
}

/** Something that would have contributed but did not, with a machine reason. `gate` = a pack whose gate
 *  is CLOSED for this chat (not in the effective graph); `empty` = a pack that produced no text this
 *  run (or whose text never reached the prompt); `budget` = history the trim stage dropped to fit the
 *  context window (the record's `trim` entry). */
export interface OmittedItem {
  /** Localizable label: for a gated pack this is its name; for a trim it is the stage's summary. */
  label: string
  reason: 'gate' | 'empty' | 'budget'
  source?: SectionSource
}

/** A closed (gate-off) pack that WOULD inject at prompt-assembly — the service derives this from the
 *  installed packs whose fragment declares a prompt-assembly rejoin but whose gate is closed. */
export interface GatedInjector {
  packId: string
  name: string
}

/** Read a pack's contributed prompt-assembly value from the engine outputs map, keyed by its rejoin
 *  edge's producing (prefixed) node+port. Returns the value or undefined when the pack produced none
 *  (a failed/absent branch — ADR 0002: its rejoin reads unwired, so nothing landed). */
export function packRejoinValue(
  outputs: Map<string, Record<string, unknown>>,
  from: { node: string; port: string }
): unknown {
  return outputs.get(from.node)?.[from.port]
}

/** Coerce a pack's rejoin value (Text `block` lane, or LorebookEntry[] `entries` lane) to the literal
 *  string(s) it injected. The `entries` lane carries objects with a `content` field (LorebookEntry);
 *  the `block` lane is a plain string. */
export function rejoinTexts(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : []
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const e of value) {
      const c = (e as { content?: unknown } | null)?.content
      if (typeof c === 'string' && c.trim()) out.push(c)
    }
    return out
  }
  return []
}

/** Per-pack attribution derived from meta.composition: which prompt-assembly rejoin edge a pack
 *  contributed on, the lane it landed (`to.port`: `entries` → top-level World Info, `block` → memory
 *  tail), and the literal texts it produced (from the engine outputs). Only packs that landed a
 *  prompt-assembly rejoin appear here. */
export interface PackInjection {
  packId: string
  name: string
  checkpoint: CheckpointId
  /** The producing (prefixed) node + port whose output value the pack rejoined with. */
  from: { node: string; port: string }
  /** The assemble anchor node + LANE port the rejoin landed on (`entries` | `block`) — the by-
   *  construction signal for WHICH narrator section the pack merged into. */
  to: { node: string; port: string }
  /** The literal contributed text(s). Empty when the pack's branch produced nothing this run
   *  (fail-open — surfaced as omitted-empty, not a section). */
  texts: string[]
}

/** Extract every pack's prompt-assembly injection from the composition meta + engine outputs. A pack
 *  may rejoin on `block` (Text) and/or `entries` (Any) — we surface one PackInjection per rejoin edge
 *  landing on the prompt-assembly checkpoint. `packNames` resolves packId → display name. */
export function packInjections(
  composition: CompositionMeta | undefined,
  outputs: Map<string, Record<string, unknown>>,
  packNames: Record<string, string>
): PackInjection[] {
  if (!composition) return []
  const out: PackInjection[] = []
  for (const [packId, pc] of Object.entries(composition.packs)) {
    for (const edge of pc.rejoinEdges) {
      if (edge.checkpoint !== 'prompt-assembly') continue
      const value = packRejoinValue(outputs, edge.from)
      out.push({
        packId,
        name: packNames[packId] ?? packId,
        checkpoint: edge.checkpoint,
        from: { node: edge.from.node, port: edge.from.port },
        to: { node: edge.to.node, port: edge.to.port },
        texts: rejoinTexts(value)
      })
    }
  }
  return out
}

export interface ShapeArgs {
  /** The forensic Execution Record the assembler produced for this (previewed) turn. */
  record: ExecutionRecord
  /** Pack injections at prompt-assembly (from packInjections). */
  injections: PackInjection[]
  /** Gate-closed packs that WOULD inject at prompt-assembly (enumerated omitted-by-gate). */
  gatedInjectors: GatedInjector[]
  /** Estimate a text's token count (the codebase's char heuristic; passed so this module stays
   *  import-light — the app has no real tokenizer). */
  estimate: (text: string) => number
}

export interface PreviewShape {
  sections: PreviewSection[]
  omitted: OmittedItem[]
}

/** Map a record entry's REAL source to the preview section-kind. This is attribution by identity — the
 *  entry says what it is (a card field, a preset block, a persona/memory marker, the history span), so
 *  there is no content sniffing. */
const sectionKindFor = (src: RecordSource): SectionKind => {
  switch (src.kind) {
    case 'card-field':
      return 'card'
    case 'persona':
      return 'persona'
    case 'memory':
      return 'memory'
    case 'history':
      return 'history'
    case 'lorebook-entry':
      return 'worldInfo'
    case 'marker':
      return src.id.startsWith('world_info') ? 'worldInfo' : 'system'
    case 'preset-block':
      return 'system'
    case 'pipeline':
      return 'system'
    default:
      return 'other'
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Slice exactly `bytes` UTF-8 bytes out of `s` starting at char index `startCharIdx`. Returns '' when
 *  the tail is shorter than `bytes` (nothing to reconstruct). A byte cut that lands mid-character yields
 *  replacement chars whose hash won't match the span's — the caller's hash guard rejects it, so this is
 *  safe to attempt speculatively. */
const sliceBytes = (s: string, startCharIdx: number, bytes: number): string => {
  const rest = Buffer.from(s.slice(startCharIdx), 'utf8')
  if (rest.length < bytes) return ''
  return rest.subarray(0, bytes).toString('utf8')
}

/** Rehydrate a hash-referenced span's FULL text from the authoritative wire (issue 08 M1 review finding
 *  1). A bulk/opaque span at/above INLINE_LIMIT is stored as a `ref` (hash + byte length + an 80-char
 *  anchor prefix), NOT the text — so the record stays small for storage (issue 09 wire dedup). But the
 *  full text still lives in `record.wire`, possibly folded into a larger role-merged message. We locate
 *  the anchor prefix in each wire message and slice exactly `bytes` UTF-8 bytes from there, then VERIFY
 *  by hash before trusting it. On any miss (anchor absent, or a later transform altered the placed text
 *  so no wire slice hashes equal) we fall back to the 80-char preview — i.e. today's behavior, no
 *  regression — never a wrong-text guess. */
const resolveRef = (c: Extract<RecordContent, { kind: 'ref' }>, wire: RecordMessage[]): string => {
  const anchor = c.preview ?? ''
  if (!anchor) return ''
  for (const m of wire) {
    let from = m.content.indexOf(anchor)
    while (from >= 0) {
      const span = sliceBytes(m.content, from, c.bytes)
      if (span && sha256(span) === c.hash) return span
      from = m.content.indexOf(anchor, from + 1)
    }
  }
  return anchor
}

/** The FULL text an entry carries. Small controlled transforms keep their exact inline text; a bulk /
 *  opaque span is hash-referenced (its authoritative copy is the wire). For a ref span we REHYDRATE the
 *  full text from `wire` at preview time (issue 08 M1 finding 1) — so a >512-byte world-info / card /
 *  memory block renders in full with token estimates on the full text, not an 80-char stub. History
 *  refs never reach here (they resolve per-turn from the wire in emitHistory). Display-only: the record
 *  stays hash-referenced for storage. */
const entryText = (c: RecordContent | undefined, wire: RecordMessage[]): string => {
  if (!c) return ''
  return c.kind === 'text' ? c.text : resolveRef(c, wire)
}

/**
 * Shape the Execution Record into attributed sections + an omitted list. Rules:
 *   · Each controlled-transform PLACEMENT entry (marker expand, non-empty non-depth literal, depth /
 *     marker inject, safety net) becomes one section attributed to the entry's OWN source — merged
 *     same-role messages are therefore decomposed to their contributing sources (the record journals
 *     each contribution BEFORE role-merge/provider-shape reshape the array).
 *   · The bulk history span expands to one `history` section per conversation turn + the final user
 *     turn as the `action` section, read from `record.wire` (the record hashes history for size).
 *   · A pack that rejoined the `entries` lane (→ top-level World Info) or the `block` lane (→ memory
 *     tail) re-attributes that narrator section to the pack — by construction (the composition meta
 *     names the lane), never by scanning the pack's text.
 *   · A `trim` entry (fitToBudget dropped oldest turns) → omitted-budget.
 *   · A pack whose branch produced nothing, or whose lane surfaced no section → omitted-empty; each
 *     gate-closed injector → omitted-gate.
 */
export function shapePreview(args: ShapeArgs): PreviewShape {
  const { record, injections, gatedInjectors, estimate } = args
  const sections: PreviewSection[] = []
  const omitted: OmittedItem[] = []

  const push = (id: SectionKind, source: SectionSource, text: string): void => {
    sections.push({ id, label: id, source, tokens: estimate(text), estimated: true, text })
  }

  // Pack rejoins that landed real text, grouped by the assemble anchor LANE they targeted. Attribution
  // by construction (ADR 0002): the lane tells us which narrator section the pack merged into, so we
  // never scan its content. `matched` tracks packs whose section actually surfaced (an unmatched live
  // pack is honestly reported omitted-empty).
  const live = injections.filter((i) => i.texts.length > 0)
  const entriesPacks = live.filter((i) => i.to.port === 'entries')
  const blockPacks = live.filter((i) => i.to.port === 'block')
  const matched = new Set<PackInjection>()

  /** The packs (if any) that merged into the narrator section this entry produces. */
  const lanePacks = (src: RecordSource): PackInjection[] => {
    if (src.kind === 'marker' && (src.id === 'world_info' || src.id === 'world_info-net')) return entriesPacks
    if (src.kind === 'memory' && src.id === 'memory-tail') return blockPacks
    return []
  }

  // Source ids that were depth-injected — their `macro` (literal) entry is the raw→rendered transform,
  // NOT the placement (the placement is the matching `depth-inject` entry), so we skip the macro one.
  const depthInjectedIds = new Set(
    record.entries.filter((e) => e.stage === 'depth-inject').map((e) => e.source.id)
  )

  const emitContent = (e: RecordEntry, precomputed?: string): void => {
    const text = precomputed ?? entryText(e.after, record.wire)
    if (!text.trim()) return
    const packs = lanePacks(e.source)
    if (packs.length) {
      for (const p of packs) matched.add(p)
      const primary = packs[0]
      push('packInject', { kind: 'pack', packId: primary.packId, name: primary.name }, text)
      return
    }
    push(sectionKindFor(e.source), { kind: 'narrator' }, text)
  }

  // Expand the bulk history span into per-turn sections from the wire (its authoritative text). The
  // conversation turns are the wire's non-system messages; the pending action is the last user turn
  // (matching provider ordering's end-on-user). Structural, from the record — not a content sniff. The
  // history turns emit in place (at the chat_history entry's position); the action is DEFERRED to the
  // end so any post-history / memory-tail block precedes it, matching the wire order.
  let historyEmitted = false
  let pendingAction: string | null = null
  const emitHistory = (wire: RecordMessage[]): void => {
    if (historyEmitted) return
    historyEmitted = true
    const conv = wire.filter((m) => m.role !== 'system')
    let lastUser = -1
    for (let i = 0; i < conv.length; i++) if (conv[i].role === 'user') lastUser = i
    conv.forEach((m, i) => {
      if (i === lastUser) pendingAction = m.content
      else push('history', { kind: 'narrator' }, m.content)
    })
  }

  for (const e of record.entries) {
    switch (e.stage) {
      case 'trim':
        omitted.push({ label: e.note ?? 'trim', reason: 'budget', source: { kind: 'narrator' } })
        break
      case 'marker-expand':
        // A history span (bulk) expands from the wire; every other marker/card-field expand is inline.
        if (e.source.kind === 'history') emitHistory(record.wire)
        else emitContent(e)
        break
      case 'macro': {
        // Literal preset block: skip when it evaluated to nothing, and skip the depth-placed ones (their
        // `depth-inject` entry is the placement) so a depth block is not counted twice.
        const text = entryText(e.after, record.wire)
        if (!text.trim() || depthInjectedIds.has(e.source.id)) break
        emitContent(e, text)
        break
      }
      case 'depth-inject':
      case 'marker-inject':
      case 'safety-net':
        emitContent(e)
        break
      // regex / opaque / system-as-user / role-merge / provider-shape: transforms + array reshapes, not
      // placements — they change existing sections' text/order, they add no new attributed section.
      default:
        break
    }
  }

  // The pending user action closes the prompt (end-on-user), so it is the last section — after any
  // post-history / memory tail journaled between the history span and the action.
  if (pendingAction !== null) push('action', { kind: 'narrator' }, pendingAction)

  // A live pack whose lane never surfaced a section (empty world info, or the block was trimmed) — its
  // contribution did not reach the assembled prompt. Honest omitted-empty.
  for (const inj of live) {
    if (!matched.has(inj)) {
      omitted.push({
        label: inj.name,
        reason: 'empty',
        source: { kind: 'pack', packId: inj.packId, name: inj.name }
      })
    }
  }

  // A pack whose branch produced NOTHING this run (empty rejoin value). Honest omitted-empty.
  for (const inj of injections) {
    if (inj.texts.length === 0) {
      omitted.push({
        label: inj.name,
        reason: 'empty',
        source: { kind: 'pack', packId: inj.packId, name: inj.name }
      })
    }
  }

  // Gate-closed injectors → omitted-gate (they WOULD inject at prompt-assembly if enabled).
  for (const g of gatedInjectors) {
    omitted.push({
      label: g.name,
      reason: 'gate',
      source: { kind: 'pack', packId: g.packId, name: g.name }
    })
  }

  return { sections, omitted }
}
