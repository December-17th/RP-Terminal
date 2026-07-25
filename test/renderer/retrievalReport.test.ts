import { describe, expect, it } from 'vitest'
import {
  buildRetrievalReportJson,
  buildRetrievalReportMarkdown,
  type ReportMeta
} from '../../src/renderer/src/components/debug/retrievalReport'
import type {
  RetrievalPreviewOk,
  RetrievalTraceRow,
  ScoredEntryRow
} from '../../src/shared/retrievalTrace'

/**
 * The Retrieval tab's export builders (pure — no React/DOM/IPC). Fixtures are hand-built here; the
 * builders must never be pointed at real user data. Asserts the viewer-order table, the evidence
 * formatting, the selection column, pipe escaping, and the JSON round-trip.
 */

const trace = (entryIndex: number, fired: boolean, matchedKey?: string): RetrievalTraceRow => ({
  bookName: 'W',
  entryIndex,
  comment: `E${entryIndex}`,
  fired,
  reason: fired ? 'key' : 'none',
  recursionPass: 0,
  probability: 100,
  ...(matchedKey ? { matchedKey } : {})
})

const scored = (
  comment: string,
  entryIndex: number,
  o: Partial<ScoredEntryRow> = {}
): ScoredEntryRow => ({
  bookName: 'W',
  entryIndex,
  comment,
  constant: false,
  fired: false,
  score: 0,
  seedScore: 0,
  linkBonus: 0,
  probabilityFactor: 1,
  keyHits: [],
  ...o
})

const meta: ReportMeta = {
  profileName: 'P',
  chatLabel: 'Alice · 12 floors',
  action: 'I open the door',
  extraPins: ['stat.hp']
}

const result: RetrievalPreviewOk = {
  ok: true,
  baseScanText: 'scan text line 1\nscan text line 2',
  pinBlock: '\n[PINS]\nstat.hp=3',
  scanDepth: 3,
  maxRecursion: 1,
  pinPaths: ['stat.mp'],
  extraPinPaths: ['stat.hp'],
  resolvedPins: [{ path: 'stat.hp', value: '3', adhoc: true }],
  lorebookNames: ['W'],
  scoringParams: {
    lambda: 0.6,
    hopDecay: 0.5,
    pinBoost: 2.5,
    maxK: 12,
    minScore: 0.6,
    relCut: 0.35,
    persistBoost: 1.5,
    actionBoost: 1,
    linkCap: 0,
    keyDamp: 1,
    relCutBasis: 'final'
  },
  prevFiredCount: 2,
  baseline: [
    trace(0, true, 'a'),
    trace(1, false),
    trace(2, true),
    trace(3, false),
    trace(4, false),
    trace(5, false),
    trace(6, false)
  ],
  rpt: [
    trace(0, true, 'a'),
    trace(1, true, 'b'),
    trace(2, true),
    trace(3, false),
    trace(4, false),
    trace(5, false),
    trace(6, false)
  ],
  scored: [
    // Constant — goes to its own section, never a table row.
    scored('CONST', 2, { constant: true, fired: true }),
    scored('Alchemy', 0, {
      fired: true,
      score: 5,
      seedScore: 5,
      keyHits: [{ key: '炼金', depth: 0, pin: false, idf: 2, weight: 1 }]
    }),
    scored('Pinned | thing', 4, {
      fired: true,
      score: 4,
      seedScore: 2.5,
      linkBonus: 1.5,
      linkFrom: 'Alchemy',
      persisted: true,
      probabilityFactor: 0.5,
      keyHits: [{ key: 'hp', depth: null, pin: true, idf: 1.2, weight: 3 }]
    }),
    scored('CutOne', 5, { score: 2, seedScore: 2, cutBy: 'cut' }),
    scored('Gated', 6, { score: 0, disqualified: 'secondary' }),
    // Zero score but keyword-fired (via pins) → after the scored block.
    scored('KeywordOnly', 1, { score: 0 }),
    // Zero score, fires nowhere → inert, last, still exported.
    scored('Inert', 3, { score: 0 })
  ]
}

const tableRows = (md: string): string[] =>
  md
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| # |') && !l.startsWith('|---'))

/** Split a table row on UNESCAPED pipes: ['', #, Entry, Book, ST, +Pin, Sel, Score, Seed, Link, Ev, '']. */
const cells = (row: string): string[] => row.split(/(?<!\\)\|/).map((c) => c.trim())

describe('buildRetrievalReportMarkdown', () => {
  it('emits every non-constant entry as a table row, in viewer order', () => {
    const rows = tableRows(buildRetrievalReportMarkdown(result, meta))
    expect(rows).toHaveLength(6) // 7 scored − 1 constant
    const names = rows.map((r) => cells(r)[2])
    // score>0 in scorer order → zero-score keyword-fired → inert (Gated scores 0 and fires nowhere).
    expect(names).toEqual([
      'Alchemy',
      'Pinned \\| thing',
      'CutOne',
      'KeywordOnly',
      'Gated',
      'Inert'
    ])
    // The constant is listed in its own section instead.
    expect(buildRetrievalReportMarkdown(result, meta)).toContain('## Constants (1)')
  })

  it('renders the header, ranks, and the untruncated scan text', () => {
    const md = buildRetrievalReportMarkdown(result, meta)
    expect(md).toContain('# Retrieval preview — Alice · 12 floors')
    expect(md).toContain('- Profile: P')
    expect(md).toContain('- Books: W')
    expect(md).toContain('- scanDepth: 3 · maxRecursion: 1')
    expect(md).toContain(
      '- Params: lambda=0.6 hop=0.5 pin=2.5 maxK=12 min=0.6 rel=0.35 persist=1.5 action=1 linkCap=0 keyDamp=1 relCutBasis=final'
    )
    expect(md).toContain('- Pending action: I open the door')
    expect(md).toContain('- Pins declared: stat.mp · ad-hoc: stat.hp')
    expect(md).toContain('- Pins resolved: stat.hp=3')
    expect(md).toContain(
      '- Summary: baseline fired 2 · +pins fired 3 · scorer fired 2 · keyword-only 1 · scorer-only 1 · held from prev floor 2'
    )
    // Fired rank is 1-based among fired non-constants; non-fired rows leave it blank.
    const rows = tableRows(md)
    expect(cells(rows[0])[1]).toBe('1')
    expect(cells(rows[1])[1]).toBe('2')
    expect(cells(rows[2])[1]).toBe('')
    expect(md).toContain('```text\nscan text line 1\nscan text line 2\n[PINS]\nstat.hp=3\n```')
  })

  it('formats pin and depth key hits, link, probability, and persistence in the evidence cell', () => {
    const rows = tableRows(buildRetrievalReportMarkdown(result, meta))
    expect(cells(rows[0])[10]).toBe('炼金·d0(idf=2)')
    expect(cells(rows[1])[10]).toBe('hp·PIN(idf=1.2) ←Alchemy(+1.5) ×p0.5 held')
    expect(cells(rows[5])[10]).toBe('—') // inert row: no evidence
    // ST / +Pin marks carry the matched key.
    expect(cells(rows[0])[4]).toBe('Y(a)')
    expect(cells(rows[3])[4]).toBe('-') // KeywordOnly missed the baseline…
    expect(cells(rows[3])[5]).toBe('Y(b)') // …and fired only with pins
  })

  it('renders the selection column: fired / cut / gate / -', () => {
    const sel = tableRows(buildRetrievalReportMarkdown(result, meta)).map((r) => cells(r)[6])
    expect(sel).toEqual(['fired', 'fired', 'cut', '-', 'gate', '-'])
  })

  it('escapes a pipe in a comment so the row keeps its column count', () => {
    const rows = tableRows(buildRetrievalReportMarkdown(result, meta))
    // 10 columns → 12 segments once the leading/trailing pipes are counted; an escaped pipe inside a
    // comment must NOT add one (the raw split does, which is exactly what the escape prevents).
    for (const r of rows) expect(cells(r)).toHaveLength(12)
    expect(rows[1].split('|')).toHaveLength(13)
    expect(rows[1]).toContain('Pinned \\| thing')
  })

  it('falls back to "(none)" for empty context and "n/a" for a missing prev-floor count', () => {
    const bare: RetrievalPreviewOk = {
      ...result,
      lorebookNames: [],
      pinPaths: [],
      resolvedPins: [],
      prevFiredCount: undefined,
      scored: []
    }
    const md = buildRetrievalReportMarkdown(bare, {
      profileName: 'P',
      chatLabel: 'X',
      action: '',
      extraPins: []
    })
    expect(md).toContain('- Books: (none)')
    expect(md).toContain('- Pending action: (none)')
    expect(md).toContain('- Pins declared: (none) · ad-hoc: (none)')
    expect(md).toContain('- Pins resolved: (none)')
    expect(md).toContain('held from prev floor n/a')
    expect(md).not.toContain('## Constants')
    expect(tableRows(md)).toHaveLength(0)
  })
})

describe('buildRetrievalReportJson', () => {
  it('round-trips the meta and the full result', () => {
    const parsed = JSON.parse(buildRetrievalReportJson(result, meta))
    expect(parsed.result.scored.length).toBe(result.scored.length)
    expect(parsed.meta).toEqual(meta)
    expect(parsed.result.baseScanText).toBe(result.baseScanText)
  })
})
