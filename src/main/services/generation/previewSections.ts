// Pure section-shaping for the next-prompt injection preview (agent-packs plan WP3.4). Given the
// assembled prompt (the flat ChatMessage[] prompt.assemble produced), the composition metadata (which
// pack fed which prompt-assembly lane — ADR 0002 attribution-by-construction), and the engine's node
// outputs (the exact pack rejoin values), classify the prompt into attributed sections + list what was
// omitted. Side-effect-free + main/renderer-free imports so it is unit-testable directly under Node
// (test/generation/previewSections.test.ts); the preview SERVICE (previewService.ts) does the engine
// run and calls this to shape the result.
//
// GROUNDING — the REAL section structure (verified against src/main/services/promptBuilder.ts):
//   `prompt.assemble` → `buildPrompt` returns a FLAT `ChatMessage[]` (role + content). There is NO
//   per-section provenance object; the only structural signals are the message ROLE and content-PREFIX
//   conventions the builder writes:
//     · `World Info:\n…`        — a world_info preset marker OR the safety-net (promptBuilder.ts:534,569)
//     · `Example dialogue:\n…`  — the mes_example marker (promptBuilder.ts:530)
//     · `[<name>'s Persona]\n…` — the persona block (promptBuilder.ts:596)
//     · char description        — `Name: …\nDescription: …` (buildCharDescription, promptBuilder.ts:197)
//     · history turns           — role user/assistant, appended by buildHistory (promptBuilder.ts:208)
//     · preset literal blocks    — arbitrary content, authored role (promptBuilder.ts:559)
//     · the memory `block` tail  — a system message injected just before the final user action
//                                  (promptBuilder.ts:637-640) — this is the `prompt-assembly.block` lane.
//   So sectioning is HEURISTIC over role + prefix. Pack attribution, by contrast, is EXACT: a pack's
//   rejoin output value (read from the engine outputs map by the rejoinEdges' `from` end) is the literal
//   text/entries it contributed, so we attribute by matching that value into the assembled messages —
//   the attributable channel ADR 0002 promises.

import type { CompositionMeta } from '../../../shared/workflow/compose'
import type { CheckpointId } from '../../../shared/workflow/attachments'

/** One message of the assembled prompt (role + content) — the shape prompt.assemble emits. */
export interface AssembledMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Where a section's text came from. `narrator` = the base workflow's own assembly (card / persona /
 *  world-info / history / preset). `pack` = a gate-open pack's prompt-assembly rejoin (packId + name).
 *  `lorebook`/`memory` are reserved for future finer attribution; today narrator world-info is reported
 *  as `narrator` (we cannot split matched-lorebook from card-authored world-info from the flat prompt). */
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

/** Something that would have contributed but did not, with a machine reason. `gate` = a pack that
 *  declares a prompt-assembly rejoin but whose gate is CLOSED for this chat (so it is not in the
 *  effective graph at all — enumerated from the closed-pack list the service passes in). */
export interface OmittedItem {
  /** Localizable label: for a gated pack this is its name; the renderer prefixes the reason. */
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

/** The character-card description block starts with `Name: ` (buildCharDescription). */
const CARD_PREFIX = 'Name: '
const WORLD_INFO_PREFIX = 'World Info:\n'
const EXAMPLE_PREFIX = 'Example dialogue:\n'
// Persona is `[<name>'s Persona]\n…` — matched by the bracketed "'s Persona]" fragment (name varies).
const PERSONA_RE = /^\[[^\]]*'s Persona\]\n/

/** Classify a single system-role message's content into a section kind by its builder prefix. */
const classifySystem = (content: string): SectionKind => {
  if (PERSONA_RE.test(content)) return 'persona'
  if (content.startsWith(WORLD_INFO_PREFIX)) return 'worldInfo'
  if (content.startsWith(EXAMPLE_PREFIX)) return 'card'
  if (content.startsWith(CARD_PREFIX)) return 'card'
  return 'system'
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
 *  string(s) it injected, for content-matching against the assembled messages. The `entries` lane
 *  carries objects with a `content` field (LorebookEntry); the `block` lane is a plain string. */
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

/** Per-pack attribution derived from meta.composition: which prompt-assembly rejoin edges a pack
 *  contributed, and the literal texts it produced (from the engine outputs). Only packs that landed a
 *  prompt-assembly rejoin appear here. */
export interface PackInjection {
  packId: string
  name: string
  checkpoint: CheckpointId
  /** The producing (prefixed) node + port whose output value the pack rejoined with. */
  from: { node: string; port: string }
  /** The literal contributed text(s), for matching into the assembled prompt. Empty when the pack's
   *  branch produced nothing this run (fail-open — attributed as omitted-empty, not a section). */
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
        texts: rejoinTexts(value)
      })
    }
  }
  return out
}

export interface ShapeArgs {
  /** The assembled prompt (prompt.assemble's sendMessages). */
  messages: AssembledMessage[]
  /** Per-message estimated token counts (parallel to `messages`) — the service computes these with the
   *  codebase's estimateTokens so this pure module stays import-light. */
  tokensPerMessage: number[]
  /** Pack injections at prompt-assembly (from packInjections). */
  injections: PackInjection[]
  /** Gate-closed packs that WOULD inject at prompt-assembly (enumerated omitted-by-gate). */
  gatedInjectors: GatedInjector[]
}

export interface PreviewShape {
  sections: PreviewSection[]
  omitted: OmittedItem[]
}

/** Does `content` contain (or equal) any of the pack's contributed texts? Substring match because the
 *  builder wraps injected values (`World Info:\n<entries>` / the block verbatim) — the pack text is a
 *  sub-run of the final message. */
const messageCarriesInjection = (content: string, texts: string[]): boolean =>
  texts.some((t) => content.includes(t.trim()) || t.includes(content.trim()))

/**
 * Shape the assembled prompt into attributed sections + an omitted list. Rules:
 *   · Consecutive same-role history turns each become one `history` section (narrator).
 *   · A system message matching a pack injection's text is a `packInject` section (attributed to the
 *     pack — the exact ADR 0002 channel). World-info that carries a pack's `entries` value is likewise
 *     re-attributed to that pack.
 *   · Other system messages classify by builder prefix (persona / card / worldInfo / system).
 *   · The final user message is the `action` section.
 *   · A pack injection whose texts are EMPTY (branch produced nothing) → omitted-empty.
 *   · Each gate-closed injector → omitted-gate.
 * Token counts ride `tokensPerMessage` (estimated).
 */
export function shapePreview(args: ShapeArgs): PreviewShape {
  const { messages, tokensPerMessage, injections, gatedInjectors } = args
  const sections: PreviewSection[] = []
  const omitted: OmittedItem[] = []

  // Injections with real text — used to re-attribute the messages that carry them. Track which
  // injections we actually matched into a section so an unmatched (non-empty) one is still honest.
  const liveInjections = injections.filter((i) => i.texts.length > 0)
  const matched = new Set<PackInjection>()

  const lastUserIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i
    return -1
  })()

  const push = (id: SectionKind, source: SectionSource, text: string, tokens: number): void => {
    sections.push({ id, label: id, source, tokens, estimated: true, text })
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const tok = tokensPerMessage[i] ?? 0

    // The trailing user action is its own section.
    if (i === lastUserIdx) {
      push('action', { kind: 'narrator' }, m.content, tok)
      continue
    }

    // A message carrying a pack's contributed text is attributed to that pack (block tail OR the
    // world-info that concatenated the pack's entries).
    const inj = liveInjections.find((x) => messageCarriesInjection(m.content, x.texts))
    if (inj) {
      matched.add(inj)
      push('packInject', { kind: 'pack', packId: inj.packId, name: inj.name }, m.content, tok)
      continue
    }

    if (m.role === 'user' || m.role === 'assistant') {
      push('history', { kind: 'narrator' }, m.content, tok)
      continue
    }
    // system
    push(classifySystem(m.content), { kind: 'narrator' }, m.content, tok)
  }

  // A pack that DID produce text but whose text we could not locate in the prompt (e.g. trimmed, or a
  // lane the assembler dropped) is reported omitted-empty is wrong; report it as a zero-length section
  // only if it truly landed. Here: a non-empty injection we never matched is surfaced omitted (its
  // contribution did not reach the assembled prompt).
  for (const inj of liveInjections) {
    if (!matched.has(inj)) {
      omitted.push({
        label: inj.name,
        reason: 'empty',
        source: { kind: 'pack', packId: inj.packId, name: inj.name }
      })
    }
  }

  // A pack whose branch produced NOTHING this run (empty rejoin value) — its attachment exists but
  // contributed no content. Honest omitted-empty.
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
