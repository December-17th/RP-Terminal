// Pure display-derivation for the Agents workspace Preview pane (agent-packs plan WP3.4). Like
// runTimeline.ts / agentPackDisplay.ts, everything here is side-effect-free + React-free so it is
// unit-testable directly (test/previewDisplay.test.ts) under Node — the Preview pane (AgentsView.tsx)
// renders these shapes and adds only localized labels + DOM.
//
// The preview payload arrives from the main-side previewService (agent-packs plan WP3.4): a list of
// per-source sections (each with an estimated token count) + an omitted list. This module derives the
// header total + the source-chip descriptor + the per-section/per-omitted label KEYS the view localizes.

/** Section source, mirrored from previewService (crosses IPC as JSON). */
export interface PreviewSource {
  kind: 'narrator' | 'pack' | 'lorebook' | 'memory'
  packId?: string
  name?: string
}

export interface PreviewSectionData {
  id: string
  label: string
  source: PreviewSource
  tokens: number
  estimated: boolean
  text: string
}

export interface PreviewOmittedData {
  label: string
  reason: 'gate' | 'empty' | 'budget'
  source?: PreviewSource
}

export interface NextPromptPreviewData {
  sections: PreviewSectionData[]
  omitted: PreviewOmittedData[]
  error?: 'no-chat' | 'failed'
  generatedAt: number
}

/** The header token total: the summed estimate over every section, plus whether ANY part is estimated
 *  (so the header labels the total "est."). Today every count is estimated (the app has no tokenizer),
 *  but the flag is derived honestly per-section so a future real count would flip it. */
export interface TokenTotal {
  total: number
  estimated: boolean
}

export function tokenTotal(sections: readonly PreviewSectionData[]): TokenTotal {
  let total = 0
  let estimated = false
  for (const s of sections) {
    total += s.tokens
    if (s.estimated) estimated = true
  }
  return { total, estimated }
}

/** The localizable label KEY for a section-kind id: `preview.section.<id>`; unknown ids fall back to
 *  `preview.section.other`. Kept as a whitelist so a stray id never produces a broken key. */
const SECTION_KIND_IDS = new Set([
  'system',
  'persona',
  'card',
  'worldInfo',
  'history',
  'memory',
  'packInject',
  'action',
  'other'
])

export function sectionLabelKey(id: string): string {
  return `preview.section.${SECTION_KIND_IDS.has(id) ? id : 'other'}`
}

/** A source-attribution chip descriptor: whether it is a pack chip (reuses the WP3.1 pack chip look) +
 *  the display text/label key. Pack chips carry the pack NAME verbatim (creator-authored); the other
 *  kinds carry a localizable key `preview.source.<kind>`. */
export interface SourceChip {
  /** true → render with the pack-chip styling (WP3.1) using `name`; false → a plain kind chip. */
  isPack: boolean
  /** For a pack chip: the pack display name (verbatim). Empty for non-pack. */
  name: string
  /** For a non-pack chip: the label key `preview.source.<kind>`. Empty for a pack chip. */
  labelKey: string
}

export function sourceChip(source: PreviewSource): SourceChip {
  if (source.kind === 'pack') {
    return { isPack: true, name: source.name ?? source.packId ?? '', labelKey: '' }
  }
  return { isPack: false, name: '', labelKey: `preview.source.${source.kind}` }
}

/** The localizable reason key for an omitted item: `preview.omitted.reason.<reason>`. */
export function omittedReasonKey(reason: PreviewOmittedData['reason']): string {
  return `preview.omitted.reason.${reason}`
}
