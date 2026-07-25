import type {
  RetrievalPreviewOk,
  RetrievalTraceRow,
  ScoredEntryRow,
  ScoredKeyHit
} from '../../../../shared/retrievalTrace'

/**
 * Export builders for the Debug window's Retrieval tab. Pure — no React, no DOM, no IPC — so the exact
 * report text is unit-testable under plain Node and the viewer only has to hand these functions the
 * IPC result plus the bits of context it holds itself (`ReportMeta`).
 *
 * The Markdown table replicates `RetrievalResult`'s row ordering (see the `useMemo` in
 * RetrievalPanel.tsx) from `result` alone, so the export and the on-screen table always agree.
 * These strings are a diagnostic artifact meant for pasting into an issue — deliberately NOT routed
 * through `t()`, unlike the viewer's own UI chrome.
 */

/** Context the viewer knows but the IPC result does not. */
export interface ReportMeta {
  profileName: string
  chatLabel: string // e.g. the character name + floor count already shown in the picker
  action: string // the pending user action typed into the viewer
  extraPins: string[] // ad-hoc pin paths the user typed
}

const NONE = '(none)'
const EMPTY = '—'

const rowKey = (r: { bookName: string; entryIndex: number }): string =>
  `${r.bookName}::${r.entryIndex}`

/** Entry label, matching the viewer's fallback chain (comment → first key hit → `#index`). */
const label = (s: ScoredEntryRow): string => s.comment || s.keyHits[0]?.key || `#${s.entryIndex}`

/** Make a value safe for a Markdown table cell: no pipes, no line breaks. */
const cell = (raw: string): string => raw.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|')

/** All key hits + link/probability/persistence, in the order the scorer reported them. */
const evidence = (s: ScoredEntryRow): string => {
  const parts: string[] = s.keyHits.map((h: ScoredKeyHit) =>
    h.pin ? `${h.key}·PIN(idf=${h.idf})` : `${h.key}·d${h.depth ?? 0}(idf=${h.idf})`
  )
  if (s.linkBonus > 0) parts.push(`←${s.linkFrom ?? ''}(+${s.linkBonus})`)
  if (s.probabilityFactor < 1) parts.push(`×p${s.probabilityFactor}`)
  if (s.persisted) parts.push('held')
  return parts.length > 0 ? parts.join(' ') : EMPTY
}

/** The selection outcome, in the viewer's precedence: fired → gate → cut reason → not considered. */
const selection = (s: ScoredEntryRow, rank: number | null): string => {
  if (rank !== null) return 'fired'
  if (s.disqualified) return 'gate'
  return s.cutBy ?? '-'
}

/** `Y(key)` when the trace fired, `-` otherwise. */
const firedMark = (trace: RetrievalTraceRow | undefined): string => {
  if (!trace?.fired) return '-'
  return trace.matchedKey ? `Y(${cell(trace.matchedKey)})` : 'Y'
}

interface OrderedRows {
  /** Non-constant scored entries, in the order the viewer's table shows them. */
  ordered: ScoredEntryRow[]
  constants: ScoredEntryRow[]
  rankOf: Map<string, number>
  baseMap: Map<string, RetrievalTraceRow>
  rptMap: Map<string, RetrievalTraceRow>
  summary: { N: number; M: number; K: number; X: number; Y: number }
}

/**
 * Mirror of the viewer's join + ordering: score>0 (the scorer's deterministic desc order), then
 * zero-score-but-keyword-fired, then inert. Derived from `result` alone.
 */
const orderRows = (result: RetrievalPreviewOk): OrderedRows => {
  const baseMap = new Map<string, RetrievalTraceRow>(result.baseline.map((r) => [rowKey(r), r]))
  const rptMap = new Map<string, RetrievalTraceRow>(result.rpt.map((r) => [rowKey(r), r]))
  const rankOf = new Map<string, number>()
  let rk = 0
  for (const s of result.scored) {
    if (s.fired && !s.constant) rankOf.set(rowKey(s), ++rk)
  }

  const nonConstant: ScoredEntryRow[] = []
  const constants: ScoredEntryRow[] = []
  for (const s of result.scored) (s.constant ? constants : nonConstant).push(s)

  const kw = (s: ScoredEntryRow): boolean =>
    !!baseMap.get(rowKey(s))?.fired || !!rptMap.get(rowKey(s))?.fired
  const ordered = [
    ...nonConstant.filter((s) => s.score > 0),
    ...nonConstant.filter((s) => s.score === 0 && kw(s)),
    ...nonConstant.filter((s) => s.score === 0 && !kw(s))
  ]

  const scoredFired = (s: ScoredEntryRow): boolean => s.fired && !s.constant
  const rptFired = (s: ScoredEntryRow): boolean => !!rptMap.get(rowKey(s))?.fired
  const summary = {
    N: result.baseline.filter((r) => r.fired).length,
    M: result.rpt.filter((r) => r.fired).length,
    K: nonConstant.filter(scoredFired).length,
    // Keyword-reference = the +pins RPT retrieval (a superset of the baseline).
    X: nonConstant.filter((s) => rptFired(s) && !scoredFired(s)).length,
    Y: nonConstant.filter((s) => scoredFired(s) && !rptFired(s)).length
  }
  return { ordered, constants, rankOf, baseMap, rptMap, summary }
}

/** A self-contained Markdown report of one retrieval dry-run — header, constants, full scored table,
 *  and the untruncated scan text. */
export const buildRetrievalReportMarkdown = (
  result: RetrievalPreviewOk,
  meta: ReportMeta
): string => {
  const { ordered, constants, rankOf, baseMap, rptMap, summary } = orderRows(result)
  const p = result.scoringParams

  const resolved = result.resolvedPins.map((r) => `${r.path}=${r.value}`).join(' · ')
  const held = typeof result.prevFiredCount === 'number' ? String(result.prevFiredCount) : 'n/a'

  const lines: string[] = [
    `# Retrieval preview — ${meta.chatLabel}`,
    '',
    `- Profile: ${meta.profileName}`,
    `- Books: ${result.lorebookNames.length > 0 ? result.lorebookNames.join(', ') : NONE}`,
    `- scanDepth: ${result.scanDepth} · maxRecursion: ${result.maxRecursion}`,
    `- Params: lambda=${p.lambda} hop=${p.hopDecay} pin=${p.pinBoost} maxK=${p.maxK} min=${p.minScore} rel=${p.relCut} persist=${p.persistBoost} action=${p.actionBoost} linkCap=${p.linkCap} keyDamp=${p.keyDamp} relCutBasis=${p.relCutBasis}`,
    `- Pending action: ${meta.action || NONE}`,
    `- Pins declared: ${result.pinPaths.length > 0 ? result.pinPaths.join(', ') : NONE} · ad-hoc: ${
      meta.extraPins.length > 0 ? meta.extraPins.join(', ') : NONE
    }`,
    `- Pins resolved: ${resolved || NONE}`,
    `- Summary: baseline fired ${summary.N} · +pins fired ${summary.M} · scorer fired ${summary.K} · keyword-only ${summary.X} · scorer-only ${summary.Y} · held from prev floor ${held}`,
    ''
  ]

  if (constants.length > 0) {
    lines.push(`## Constants (${constants.length})`, '')
    for (const c of constants) lines.push(`- ${label(c)}`)
    lines.push('')
  }

  lines.push(
    '## Scored entries',
    '',
    '| # | Entry | Book | ST | +Pin | Sel | Score | Seed | Link | Evidence |',
    '|---|-------|------|----|----|-----|-------|------|------|----------|'
  )
  for (const s of ordered) {
    const k = rowKey(s)
    const rank = rankOf.get(k) ?? null
    lines.push(
      `| ${rank ?? ''} | ${cell(label(s))} | ${cell(s.bookName)} | ${firedMark(
        baseMap.get(k)
      )} | ${firedMark(rptMap.get(k))} | ${selection(s, rank)} | ${s.score} | ${s.seedScore} | ${
        s.linkBonus
      } | ${cell(evidence(s))} |`
    )
  }

  lines.push(
    '',
    '## Scan text',
    '',
    '```text',
    `${result.baseScanText}${result.pinBlock}`,
    '```',
    ''
  )
  return lines.join('\n')
}

/** The raw dry-run result plus viewer context, for machine consumption / attaching to an issue. */
export const buildRetrievalReportJson = (result: RetrievalPreviewOk, meta: ReportMeta): string =>
  JSON.stringify({ meta, result }, null, 2)
