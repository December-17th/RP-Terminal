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
import { scoreLoreEntries, type ScoreSegment } from '../src/main/services/loreScoring'
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
  lambda: [0.4, 0.5, 0.6, 0.7, 0.8],
  hopDecay: [0.25, 0.5, 0.75],
  pinBoost: [1.5, 2.5, 4.0],
  topK: [4, 6, 8, 10, 12]
}

const f3 = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : '—')
const paramStr = (p: ScoringParams): string =>
  `λ=${p.lambda} hop=${p.hopDecay} pin=${p.pinBoost} K=${p.topK}`
const refKey = (r: EntryRef): string => `${r.bookName}::${r.entryIndex}`
const sameParams = (a: ScoringParams, b: ScoringParams): boolean =>
  a.lambda === b.lambda && a.hopDecay === b.hopDecay && a.pinBoost === b.pinBoost && a.topK === b.topK

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

    // --- Grid search (violations are always 0 on proxy labels; rank by F1 then precision then closeness) ---
    const distFromDefault = (p: ScoringParams): number =>
      Math.abs(p.lambda - DEFAULT_SCORING_PARAMS.lambda) / 0.4 +
      Math.abs(p.hopDecay - DEFAULT_SCORING_PARAMS.hopDecay) / 0.5 +
      Math.abs(p.pinBoost - DEFAULT_SCORING_PARAMS.pinBoost) / 2.5 +
      Math.abs(p.topK - DEFAULT_SCORING_PARAMS.topK) / 8
    const combos: Array<{ params: ScoringParams; micro: MicroAgg }> = []
    for (const lambda of GRID.lambda)
      for (const hopDecay of GRID.hopDecay)
        for (const pinBoost of GRID.pinBoost)
          for (const topK of GRID.topK) {
            const params = { lambda, hopDecay, pinBoost, topK }
            combos.push({ params, micro: microScorer(scenarios, params) })
          }
    combos.sort(
      (a, b) =>
        b.micro.f1 - a.micro.f1 ||
        b.micro.precision - a.micro.precision ||
        distFromDefault(a.params) - distFromDefault(b.params)
    )
    const defaultIdx = combos.findIndex((c) => sameParams(c.params, DEFAULT_SCORING_PARAMS))
    const best = combos[0]
    const defaultCombo = combos[defaultIdx]
    const baseline = microKeywordBaseline(scenarios)

    // --- Unsupervised stats at DEFAULT params ---
    const chatLabels = [...new Set(samples.map((s) => s.chatLabel))]
    const perChat: Record<string, { firedScorer: number[]; firedKeyword: number[]; scores: number[] }> = {}
    for (const l of chatLabels) perChat[l] = { firedScorer: [], firedKeyword: [], scores: [] }
    // fired sets in floor order (per chat) for churn.
    const scorerFiredByChat: Record<string, Array<Set<string>>> = {}
    const keywordFiredByChat: Record<string, Array<Set<string>>> = {}
    for (const l of chatLabels) {
      scorerFiredByChat[l] = []
      keywordFiredByChat[l] = []
    }
    for (const s of samples) {
      const sc = evaluate(s.scenario, DEFAULT_SCORING_PARAMS)
      const kw = evaluateKeywordBaseline(s.scenario)
      perChat[s.chatLabel].firedScorer.push(sc.firedCount)
      perChat[s.chatLabel].firedKeyword.push(kw.firedCount)
      scorerFiredByChat[s.chatLabel].push(new Set(sc.fired.map(refKey)))
      keywordFiredByChat[s.chatLabel].push(new Set(kw.fired.map(refKey)))
      for (const row of scoreLoreEntries(s.scenario.books, s.scenario.segments, '', DEFAULT_SCORING_PARAMS)) {
        if (!row.constant && row.score > 0) perChat[s.chatLabel].scores.push(row.score)
      }
    }
    const symDiff = (a: Set<string>, b: Set<string>): number => {
      let d = 0
      for (const x of a) if (!b.has(x)) d++
      for (const x of b) if (!a.has(x)) d++
      return d
    }
    const meanChurn = (seq: Array<Set<string>>): number => {
      if (seq.length < 2) return 0
      let sum = 0
      for (let i = 0; i + 1 < seq.length; i++) sum += symDiff(seq[i], seq[i + 1])
      return sum / (seq.length - 1)
    }
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
    const pct = (xs: number[], p: number): number => {
      if (xs.length === 0) return 0
      const s = [...xs].sort((a, b) => a - b)
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
    }
    const allScores = chatLabels.flatMap((l) => perChat[l].scores)
    const overall = {
      firedScorer: mean(chatLabels.flatMap((l) => perChat[l].firedScorer)),
      firedKeyword: mean(chatLabels.flatMap((l) => perChat[l].firedKeyword)),
      churnScorer: mean(chatLabels.map((l) => meanChurn(scorerFiredByChat[l]))),
      churnKeyword: mean(chatLabels.map((l) => meanChurn(keywordFiredByChat[l]))),
      p50: pct(allScores, 50),
      p90: pct(allScores, 90),
      max: allScores.length ? Math.max(...allScores) : 0
    }

    // --- Console ---
    // eslint-disable-next-line no-console
    console.log(
      `\nSamples: ${chats} chat(s) × ${samples.length} (chat,floor) points, ${entries} entries, scanDepth=${scanDepth}` +
        `\nBest ${paramStr(best.params)} F1=${f3(best.micro.f1)} P=${f3(best.micro.precision)} R=${f3(best.micro.recall)}` +
        `\nDefault ${paramStr(DEFAULT_SCORING_PARAMS)} rank ${defaultIdx + 1}/${combos.length} F1=${f3(defaultCombo.micro.f1)} P=${f3(defaultCombo.micro.precision)} R=${f3(defaultCombo.micro.recall)}` +
        `\nKeyword baseline F1=${f3(baseline.f1)} P=${f3(baseline.precision)} R=${f3(baseline.recall)}` +
        `\nfired/floor scorer=${f3(overall.firedScorer)} keyword=${f3(overall.firedKeyword)} · churn scorer=${f3(overall.churnScorer)} keyword=${f3(overall.churnKeyword)}`
    )

    // --- Markdown report (aggregate numbers + anonymized labels ONLY) ---
    const row = (rank: string, p: string, m: MicroAgg): string =>
      `| ${rank} | ${p} | ${f3(m.precision)} | ${f3(m.recall)} | ${f3(m.f1)} |`
    const header = '| Rank | Params | Precision | Recall | F1 |\n|---|---|---|---|---|'
    const topRows = combos.slice(0, 10).map((c, i) => row(String(i + 1), paramStr(c.params), c.micro))
    const defaultBest = combos[0]
    const contradicts =
      defaultCombo.micro.f1 + 0.02 < defaultBest.micro.f1 &&
      defaultBest.params.topK > DEFAULT_SCORING_PARAMS.topK

    const doc = `# Lore-scoring real-data evaluation (2026-07-23)

**Status: PoC — debug window only; diagnostic, NOT a defaults decision.** Replays stored chats from the
dev data dir against a next-response proxy label and grid-searches \`ScoringParams\`. Proxy label: an
enabled non-constant entry is "relevant" for floor N iff one of its primary keys appears in the stored
text of response N. No hard-negative set on real data — metrics are micro-aggregated precision/recall/F1
vs. the proxy only. \`DEFAULT_SCORING_PARAMS\` is NOT changed from these numbers (see limitations).

## Sample size

- Chats replayed (≥4 floors): **${chats}**
- (chat, floor) samples: **${samples.length}**
- Lorebook entries in scope: **${entries}**
- scanDepth: **${scanDepth}** · maxRecursion: **0** (app default; the keyword baseline uses the same)
- Pins: none (real cards declare no \`pin_paths\`) — **the \`pinBoost\` axis is NOT exercised by real data.**

## Grid top 10 (by micro-F1)

${header}
${topRows.join('\n')}

## Default vs. baseline

| Rank | Params | Precision | Recall | F1 |
|---|---|---|---|---|
${row(`${defaultIdx + 1}/${combos.length}`, `${paramStr(DEFAULT_SCORING_PARAMS)} (DEFAULT)`, defaultCombo.micro)}
${row('best', paramStr(best.params), best.micro)}
${row('—', 'ST-keyword baseline', baseline)}

## Unsupervised stats at default params

| Metric | Scorer | ST-keyword |
|---|---|---|
| mean fired / floor | ${f3(overall.firedScorer)} | ${f3(overall.firedKeyword)} |
| mean churn (|Δ fired| between consecutive floors) | ${f3(overall.churnScorer)} | ${f3(overall.churnKeyword)} |

Scorer score distribution (non-constant, score > 0): p50 ${f3(overall.p50)} · p90 ${f3(overall.p90)} · max ${f3(overall.max)}.

## Real vs. synthetic conclusion

${
  contradicts
    ? `**⚠ CONTRADICTION:** on real data the best combo (${paramStr(best.params)}, F1 ${f3(best.micro.f1)}) uses a LARGER topK than the synthetic-tuned default (topK ${DEFAULT_SCORING_PARAMS.topK}, rank ${defaultIdx + 1}, F1 ${f3(defaultCombo.micro.f1)}). The synthetic suite favored a smaller topK; real proxy labels disagree. Do NOT act on this alone — investigate before changing defaults.`
    : `The synthetic-tuned default (topK ${DEFAULT_SCORING_PARAMS.topK}) ranks ${defaultIdx + 1}/${combos.length} on real data (F1 ${f3(defaultCombo.micro.f1)}) vs. the real-data best ${paramStr(best.params)} (F1 ${f3(best.micro.f1)}). No contradiction: real data does not clearly prefer a larger topK than the synthetic conclusion. Defaults are kept.`
}

## Limitations

- **Proxy-label bias.** "Relevant = key appears in the stored response" is a keyword-flavored oracle: it
  rewards the ST-keyword behavior it is meant to be compared against, and mislabels both directions —
  entries the story *needed* but never named (needs-without-mention → false negatives) and entries merely
  *mentioned in passing* without narrative need (mentions-without-need → false positives).
- **Pins unexercised.** No real card declares \`pin_paths\`, so \`pinBoost\` (and pin-driven recall) is
  untested here; the synthetic suite is the only pinBoost evidence.
- **Small, homogeneous sample.** A single dev data dir with few chats is not representative; treat these
  numbers as a smoke signal, not a decision basis.
- **No recursion.** maxRecursion=0 (app default) — recursion-lifted retrieval is not measured.

_Diagnostic replay of local dev data; proxy labels are too weak to retune \`DEFAULT_SCORING_PARAMS\`._
`
    const outDir = path.join(process.cwd(), 'docs')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'lore-scoring-real-data-2026-07-23.md'), doc)
    // eslint-disable-next-line no-console
    console.log(`\nReport written. Real vs synthetic: ${contradicts ? 'CONTRADICTS topK' : 'consistent'}.`)
  })
})
