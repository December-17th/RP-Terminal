import { describe, it, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Real-floor-data evaluation mode for the deterministic lore scorer. SKIPPED in the normal suite; run
 * with `npm run tune:lore:real` (sets TUNE_LORE_REAL=1). It replays every stored (chat, floor) of the
 * dev data dir and scores retrieval against a next-response PROXY label (an enabled non-constant entry is
 * "relevant" iff one of its primary keys appears in the text of that floor's stored response), then
 * grid-searches params and writes docs/lore-scoring-real-data-2026-07-23.md.
 *
 * SAFETY (hard rules): the real data dir is COPIED to a fresh temp dir and the storage layer is repointed
 * there (via the retrievalPreviewIpc.test node-adapter + getAppDir mock pattern) — the original dir is
 * never opened or written. NOTHING from the real data reaches a committed file: the report contains only
 * aggregate numbers and anonymized chat labels. No profile/chat ids are hardcoded here — they are
 * enumerated at runtime. If the dir is absent the harness SKIPS with a message, never fails.
 */

const RUN = process.env.TUNE_LORE_REAL === '1'
const REAL_DIR = path.join(process.cwd(), 'rp-terminal-data')
const HAS_DATA = RUN && fs.existsSync(path.join(REAL_DIR, 'rpterminal.db'))

// A fresh temp copy the storage layer is repointed at (only when actually running).
const TEMP_DIR = RUN ? fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-lore-real-')) : ''

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => TEMP_DIR }
})

import { getProfiles } from '../src/main/services/profileService'
import { getChats, getChat, getChatLorebookIds } from '../src/main/services/chatService'
import { getCharacter } from '../src/main/services/characterService'
import { getLorebookById, keyMatchesText } from '../src/main/services/lorebookService'
import { getAllFloors } from '../src/main/services/floorService'
import { getSettings } from '../src/main/services/settingsService'
import { getDb } from '../src/main/services/db'
import * as sessionDbService from '../src/main/services/sessionDbService'
import { cleanForHistory } from '../src/shared/responseView'
import { type ScoreSegment } from '../src/main/services/loreScoring'
import { DEFAULT_SCORING_PARAMS, type ScoringParams } from '../src/shared/retrievalTrace'
import type { Lorebook } from '../src/main/types/character'
import type { EntryRef, Scenario } from './fixtures/loreScoring/scenarios'
import {
  evaluate,
  evaluateKeywordBaseline,
  microScorer,
  microKeywordBaseline,
  type MicroAgg
} from './fixtures/loreScoring/metrics'

const GRID = {
  // Report-only: hold λ/hop/pin at the current defaults and grid the selection knobs (100 combos).
  maxK: [4, 8, 12, 16],
  minScore: [0, 0.15, 0.3, 0.6, 1.0],
  relCut: [0, 0.1, 0.2, 0.35, 0.5]
}

// Equivalent of the OLD fixed-K=4 behavior (floor + cut disabled) for the before/after comparison.
const OLD_EQUIV: ScoringParams = { ...DEFAULT_SCORING_PARAMS, maxK: 4, minScore: 0, relCut: 0 }

const f3 = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : '—')
const paramStr = (p: ScoringParams): string =>
  `maxK=${p.maxK} min=${p.minScore} rel=${p.relCut}`
const refKey = (r: EntryRef): string => `${r.bookName}::${r.entryIndex}`

interface Sample {
  chatLabel: string
  floor: number
  scenario: Scenario
}

/** Build the retrieval segments for predicting response N — mirrors debugIpc, at historical floor N. */
const buildSegments = (
  floors: ReturnType<typeof getAllFloors>,
  n: number,
  scanDepth: number
): ScoreSegment[] => {
  const floorN = floors.find((f) => f.floor === n)!
  const history = floors.filter((f) => f.floor < n).slice(-Math.max(1, scanDepth))
  const segments: ScoreSegment[] = []
  const action = floorN.user_message.content
  if (action) segments.push({ depth: 0, text: action })
  for (let i = history.length - 1, depth = 1; i >= 0; i--, depth++) {
    const f = history[i]
    const text = [f.user_message.content, cleanForHistory(f.response.content)].filter(Boolean).join('\n')
    if (text) segments.push({ depth, text })
  }
  return segments
}

/** Proxy-relevant refs: enabled non-constant entries with a primary key present in response N's text. */
const proxyRelevant = (
  books: Array<{ name: string; lorebook: Lorebook }>,
  responseText: string
): EntryRef[] => {
  const out: EntryRef[] = []
  for (const { name, lorebook } of books) {
    lorebook.entries.forEach((e, i) => {
      if (!e.enabled || e.constant) return
      const keys = [...new Set(e.keys.filter(Boolean))]
      if (keys.some((k) => keyMatchesText(k, responseText, e.case_sensitive))) {
        out.push({ bookName: name, entryIndex: i })
      }
    })
  }
  return out
}

const collectSamples = (): { samples: Sample[]; chats: number; entries: number; scanDepth: number } => {
  const samples: Sample[] = []
  let chatCount = 0
  let entryTotal = 0
  let scanDepthSeen = 3
  let labelIdx = 0
  for (const profile of getProfiles()) {
    const settings = getSettings(profile.id)
    const scanDepth = settings.lorebook?.scan_depth ?? 3
    scanDepthSeen = scanDepth
    for (const chatRow of getChats(profile.id)) {
      const chat = getChat(profile.id, chatRow.id)
      if (!chat) continue
      const floors = getAllFloors(profile.id, chatRow.id, chat.floor_count ?? 0)
      if (floors.length < 4) continue
      const card = getCharacter(profile.id, chat.character_id)
      if (!card) continue
      const lorebookIds = getChatLorebookIds(profile.id, chatRow.id) ?? [chat.character_id]
      const books = lorebookIds
        .map((id) => getLorebookById(profile.id, id))
        .filter((lb): lb is Lorebook => lb !== null)
        .map((lb) => ({ name: lb.name, lorebook: lb }))
      if (books.length === 0) continue
      entryTotal += books.reduce((n, b) => n + b.lorebook.entries.length, 0)
      const chatLabel = `chat-${String.fromCharCode(65 + labelIdx++)}`
      chatCount++
      const maxFloor = Math.max(...floors.map((f) => f.floor))
      for (let n = 2; n <= maxFloor; n++) {
        const floorN = floors.find((f) => f.floor === n)
        if (!floorN || !floorN.response.content) continue
        const segments = buildSegments(floors, n, scanDepth)
        if (segments.length === 0) continue
        samples.push({
          chatLabel,
          floor: n,
          scenario: {
            name: `${chatLabel}#${n}`,
            category: 'real',
            books,
            segments,
            pinText: '',
            relevant: proxyRelevant(books, floorN.response.content),
            hardNegative: []
          }
        })
      }
    }
  }
  return { samples, chats: chatCount, entries: entryTotal, scanDepth: scanDepthSeen }
}

;(HAS_DATA ? describe : describe.skip)('lore-scoring real-data evaluation', () => {
  afterAll(() => {
    try {
      sessionDbService.closeAll()
    } catch {
      /* ignore */
    }
    try {
      ;(getDb() as unknown as { close: () => void }).close()
    } catch {
      /* ignore */
    }
    try {
      if (TEMP_DIR) fs.rmSync(TEMP_DIR, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  beforeAll(() => {
    // Copy the real dir into the temp sandbox BEFORE any service opens a DB. Read-only intent: every
    // service write below lands in the copy, never the original.
    fs.cpSync(REAL_DIR, TEMP_DIR, { recursive: true })
  })

  // Generous timeout: the grid (225 combos) × samples × a large real lorebook is CPU-heavy but this file
  // is env-gated and never runs in the normal suite.
  it('grid-searches params on real floors and writes the report', { timeout: 600_000 }, () => {
    const { samples, chats, entries, scanDepth } = collectSamples()
    if (samples.length === 0) {
      // eslint-disable-next-line no-console
      console.log('No usable (chat, floor) samples (need chats with ≥4 floors). Skipping.')
      return
    }
    const scenarios = samples.map((s) => s.scenario)
    const chatLabels = [...new Set(samples.map((s) => s.chatLabel))]

    // --- Per-config stats: micro P/R/F1 + mean fired/floor + mean floor-to-floor churn ---
    const symDiff = (a: Set<string>, b: Set<string>): number => {
      let d = 0
      for (const x of a) if (!b.has(x)) d++
      for (const x of b) if (!a.has(x)) d++
      return d
    }
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
    const meanChurn = (seq: Array<Set<string>>): number => {
      if (seq.length < 2) return 0
      let sum = 0
      for (let i = 0; i + 1 < seq.length; i++) sum += symDiff(seq[i], seq[i + 1])
      return sum / (seq.length - 1)
    }
    interface Stats {
      micro: MicroAgg
      firedPerFloor: number
      churn: number
    }
    const statsAt = (p: ScoringParams): Stats => {
      const firedCounts: number[] = []
      const byChat: Record<string, Array<Set<string>>> = {}
      for (const l of chatLabels) byChat[l] = []
      for (const s of samples) {
        const e = evaluate(s.scenario, p)
        firedCounts.push(e.firedCount)
        byChat[s.chatLabel].push(new Set(e.fired.map(refKey)))
      }
      return {
        micro: microScorer(scenarios, p),
        firedPerFloor: mean(firedCounts),
        churn: mean(chatLabels.map((l) => meanChurn(byChat[l])))
      }
    }

    // --- Grid the selection knobs only; rank by F1 then precision (proxy violations are always 0) ---
    const combos: Array<{ params: ScoringParams; micro: MicroAgg }> = []
    for (const maxK of GRID.maxK)
      for (const minScore of GRID.minScore)
        for (const relCut of GRID.relCut) {
          const params = { ...DEFAULT_SCORING_PARAMS, maxK, minScore, relCut }
          combos.push({ params, micro: microScorer(scenarios, params) })
        }
    combos.sort((a, b) => b.micro.f1 - a.micro.f1 || b.micro.precision - a.micro.precision)
    const best = combos[0]

    const statsOld = statsAt(OLD_EQUIV)
    const statsNew = statsAt(DEFAULT_SCORING_PARAMS)
    const statsBest = statsAt(best.params)

    // Keyword baseline stats (fired/floor + churn).
    const kwFired: number[] = []
    const kwByChat: Record<string, Array<Set<string>>> = {}
    for (const l of chatLabels) kwByChat[l] = []
    for (const s of samples) {
      const kw = evaluateKeywordBaseline(s.scenario)
      kwFired.push(kw.firedCount)
      kwByChat[s.chatLabel].push(new Set(kw.fired.map(refKey)))
    }
    const keyword = microKeywordBaseline(scenarios)
    const kwFiredPerFloor = mean(kwFired)
    const kwChurn = mean(chatLabels.map((l) => meanChurn(kwByChat[l])))

    // Recall-recovery question: does floor+relCut (allowing a higher maxK) recover the recall that a bare
    // K=4 cap lost, while keeping fired/floor and churn far below the keyword baseline's?
    const recallRecovered =
      statsBest.micro.recall > statsOld.micro.recall + 0.02 &&
      statsBest.firedPerFloor < kwFiredPerFloor &&
      statsBest.churn < kwChurn

    // eslint-disable-next-line no-console
    console.log(
      `\nSamples: ${chats} chat(s) × ${samples.length} (chat,floor), ${entries} entries, scanDepth=${scanDepth}` +
        `\nOLD  ${paramStr(OLD_EQUIV)} P=${f3(statsOld.micro.precision)} R=${f3(statsOld.micro.recall)} F1=${f3(statsOld.micro.f1)} fired/floor=${f3(statsOld.firedPerFloor)} churn=${f3(statsOld.churn)}` +
        `\nNEW  ${paramStr(DEFAULT_SCORING_PARAMS)} P=${f3(statsNew.micro.precision)} R=${f3(statsNew.micro.recall)} F1=${f3(statsNew.micro.f1)} fired/floor=${f3(statsNew.firedPerFloor)} churn=${f3(statsNew.churn)}` +
        `\nBEST ${paramStr(best.params)} P=${f3(statsBest.micro.precision)} R=${f3(statsBest.micro.recall)} F1=${f3(statsBest.micro.f1)} fired/floor=${f3(statsBest.firedPerFloor)} churn=${f3(statsBest.churn)}` +
        `\nKEYWORD P=${f3(keyword.precision)} R=${f3(keyword.recall)} F1=${f3(keyword.f1)} fired/floor=${f3(kwFiredPerFloor)} churn=${f3(kwChurn)}` +
        `\nRecall recovered by floor+relCut: ${recallRecovered ? 'YES' : 'NO'}`
    )

    // --- Markdown report (aggregate numbers + anonymized labels ONLY) ---
    const gridRow = (rank: string, p: string, m: MicroAgg): string =>
      `| ${rank} | ${p} | ${f3(m.precision)} | ${f3(m.recall)} | ${f3(m.f1)} |`
    const statRow = (label: string, p: ScoringParams, st: Stats): string =>
      `| ${label} | ${paramStr(p)} | ${f3(st.micro.precision)} | ${f3(st.micro.recall)} | ${f3(st.micro.f1)} | ${f3(st.firedPerFloor)} | ${f3(st.churn)} |`
    const gridHeader = '| Rank | Params | Precision | Recall | F1 |\n|---|---|---|---|---|'
    const topRows = combos.slice(0, 10).map((c, i) => gridRow(String(i + 1), paramStr(c.params), c.micro))

    const doc = `# Lore-scoring real-data evaluation — adaptive selection (2026-07-24)

**Status: PoC — debug window only; diagnostic, NOT a defaults decision.** Supersedes
lore-scoring-real-data-2026-07-23.md (point-in-time). Replays stored chats from the dev data dir against a
next-response proxy label: an enabled non-constant entry is "relevant" for floor N iff one of its primary
keys appears in the stored text of response N. λ/hop/pin are held at the current defaults; only the
selection knobs (maxK × minScore × relCut) are gridded. Metrics are micro-aggregated P/R/F1 vs. the proxy
(no hard negatives). \`DEFAULT_SCORING_PARAMS\` is NOT changed from these numbers (proxy is too weak).

## Sample size

- Chats replayed (≥4 floors): **${chats}**
- (chat, floor) samples: **${samples.length}**
- Lorebook entries in scope: **${entries}**
- scanDepth: **${scanDepth}** · maxRecursion: **0** (app default; the keyword baseline uses the same)
- Pins: none (real cards declare no \`pin_paths\`) — **the \`pinBoost\` axis is NOT exercised by real data.**

## Selection-grid top 10 (by micro-F1)

${gridHeader}
${topRows.join('\n')}

## Before / after / best / keyword

| Config | Params | Precision | Recall | F1 | fired/floor | churn |
|---|---|---|---|---|---|---|
${statRow('OLD (K=4, floor+cut off)', OLD_EQUIV, statsOld)}
${statRow('NEW default', DEFAULT_SCORING_PARAMS, statsNew)}
${statRow('grid best', best.params, statsBest)}
| ST-keyword | maxRecursion=0 | ${f3(keyword.precision)} | ${f3(keyword.recall)} | ${f3(keyword.f1)} | ${f3(kwFiredPerFloor)} | ${f3(kwChurn)} |

## Recall recovery

**Does floor + relCut recover the recall a bare K=4 cap lost on the ${entries}-entry book, while keeping
fired/floor and churn low? ${recallRecovered ? 'YES' : 'NO'}.** On this data, lifting recall requires a
large \`maxK\`: the grid best (${paramStr(best.params)}) reaches recall ${f3(statsBest.micro.recall)}
(vs. OLD K=4 recall ${f3(statsOld.micro.recall)}) but only by firing ${f3(statsBest.firedPerFloor)}/floor
with churn ${f3(statsBest.churn)} — around the keyword baseline's ${f3(kwFiredPerFloor)}/floor and churn
${f3(kwChurn)}. So the floor/relative-cut do NOT let a small \`maxK\` recover recall here; the score
distribution on this book is broad rather than sharply peaked, so few entries clear \`relCut·top\`.
Floor+relCut alone (NEW default, ${paramStr(DEFAULT_SCORING_PARAMS)}) instead trims the low-idf tail: it
slightly lowers recall vs. bare K=4 (${f3(statsNew.micro.recall)} vs. ${f3(statsOld.micro.recall)}) but
cuts fired/floor (${f3(statsOld.firedPerFloor)} → ${f3(statsNew.firedPerFloor)}) and churn
(${f3(statsOld.churn)} → ${f3(statsNew.churn)}) — a precision / cache-stability move, not a recall lever.
The proxy label is keyword-flavored and structurally favors the broad keyword baseline on recall, so read
these as directional. \`maxK\` stays 4 by default (precision); raise it in the viewer to trade for recall.

## Limitations

- **Proxy-label bias.** "Relevant = key appears in the stored response" is a keyword-flavored oracle: it
  rewards the ST-keyword behavior it is meant to be compared against, and mislabels both directions —
  needs-without-mention (false negatives) and mentions-without-need (false positives).
- **Pins unexercised.** No real card declares \`pin_paths\`, so \`pinBoost\` is untested here.
- **Small, homogeneous sample.** A single dev data dir with few chats is a smoke signal, not a basis.
- **No recursion.** maxRecursion=0 (app default) — recursion-lifted retrieval is not measured.

_Diagnostic replay of local dev data; proxy labels are too weak to retune \`DEFAULT_SCORING_PARAMS\`._
`
    const outDir = path.join(process.cwd(), 'docs')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'lore-scoring-real-data-2026-07-24.md'), doc)
    // eslint-disable-next-line no-console
    console.log(`\nReport written. Recall recovered: ${recallRecovered ? 'YES' : 'NO'}.`)
  })
})
