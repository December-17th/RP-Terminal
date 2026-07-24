import { describe, it, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Real-floor-data evaluation mode for the deterministic lore scorer. SKIPPED in the normal suite; run
 * with `npm run tune:lore:real` (sets TUNE_LORE_REAL=1). It replays every stored (chat, floor) of the
 * dev data dir and scores retrieval against a next-response PROXY label (an enabled non-constant entry is
 * "relevant" iff one of its primary keys appears in the text of that floor's stored response), then
 * grid-searches params (incl. the persistence axis, with prevFired threaded sequentially per chat) and
 * writes docs/lore-scoring-real-data-persist-2026-07-24.md.
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
import { buildPinBlock } from '../src/main/services/promptBuilder'
import { getDb } from '../src/main/services/db'
import * as sessionDbService from '../src/main/services/sessionDbService'
import { cleanForHistory } from '../src/shared/responseView'
import { type ScoreSegment } from '../src/main/services/loreScoring'
import { DEFAULT_SCORING_PARAMS, type ScoringParams } from '../src/shared/retrievalTrace'
import { getRpExt, type Lorebook } from '../src/main/types/character'
import type { EntryRef, Scenario } from './fixtures/loreScoring/scenarios'
import {
  evaluate,
  evaluateKeywordBaseline,
  microAggregate,
  type EvalResult,
  type MicroAgg
} from './fixtures/loreScoring/metrics'

const GRID = {
  // Report-only: λ/hop AND pinBoost held at the defaults (pinBoost fixed at 2.5 — the keyword-flavored
  // proxy cannot separate pinBoost values, documented in the prior real-data doc). Grid the selection
  // knobs + the NEW persistence axis: 4 × 3 × 3 × 3 = 108 combos.
  maxK: [4, 8, 12, 16],
  minScore: [0, 0.3, 0.6],
  relCut: [0, 0.2, 0.35],
  persistBoost: [1, 1.5, 2]
}
const PIN_BOOST = 2.5

const f3 = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : '—')
const paramStr = (p: ScoringParams): string =>
  `maxK=${p.maxK} min=${p.minScore} rel=${p.relCut} persist=${p.persistBoost}`
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

interface Collected {
  samples: Sample[]
  chats: number
  entries: number
  scanDepth: number
  /** Whether any replayed chat declared `pin_paths` (so the pin axis is actually exercised). */
  pinsDeclared: boolean
  /** How pin variable state was resolved: per-floor (floor N-1 snapshot) or the chat's current vars. */
  varsMode: 'per-floor' | 'current'
}

const collectSamples = (): Collected => {
  const samples: Sample[] = []
  let chatCount = 0
  let entryTotal = 0
  let scanDepthSeen = 3
  let labelIdx = 0
  let pinsDeclared = false
  let varsMode: 'per-floor' | 'current' = 'per-floor'
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
      // Context pins declared on the card (exactly what the live handler reads via getRpExt).
      const pinPaths = getRpExt(card)?.pin_paths ?? []
      if (pinPaths.length > 0) pinsDeclared = true
      // Per-floor variable snapshots let us resolve pins AS OF floor N (the state generation of floor N
      // saw = floor N-1's post-state). Fall back to the chat's current (latest) vars if snapshots are
      // absent, and record which mode ran.
      const hasPerFloorVars = floors.some((f) => Object.keys(f.variables ?? {}).length > 0)
      if (!hasPerFloorVars) varsMode = 'current'
      const currentVars = floors[floors.length - 1]?.variables ?? {}
      const chatLabel = `chat-${String.fromCharCode(65 + labelIdx++)}`
      chatCount++
      const maxFloor = Math.max(...floors.map((f) => f.floor))
      for (let n = 2; n <= maxFloor; n++) {
        const floorN = floors.find((f) => f.floor === n)
        if (!floorN || !floorN.response.content) continue
        const segments = buildSegments(floors, n, scanDepth)
        if (segments.length === 0) continue
        const varsForN = hasPerFloorVars
          ? (floors.find((f) => f.floor === n - 1)?.variables ?? {})
          : currentVars
        const pinText = pinPaths.length ? buildPinBlock(varsForN as Record<string, unknown>, pinPaths) : ''
        samples.push({
          chatLabel,
          floor: n,
          scenario: {
            name: `${chatLabel}#${n}`,
            category: 'real',
            books,
            segments,
            pinText,
            relevant: proxyRelevant(books, floorN.response.content),
            hardNegative: []
          }
        })
      }
    }
  }
  return {
    samples,
    chats: chatCount,
    entries: entryTotal,
    scanDepth: scanDepthSeen,
    pinsDeclared,
    varsMode
  }
}

/** Count entries whose any primary key matches the pin block text (pin-hit entries). */
const pinHitCount = (books: Array<{ name: string; lorebook: Lorebook }>, pinText: string): number => {
  if (!pinText) return 0
  let hits = 0
  for (const { lorebook } of books) {
    for (const e of lorebook.entries) {
      if (!e.enabled || e.constant) continue
      const keys = [...new Set(e.keys.filter(Boolean))]
      if (keys.some((k) => keyMatchesText(k, pinText, e.case_sensitive))) hits++
    }
  }
  return hits
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

  // Generous timeout: the grid (108 combos) × samples × a large real lorebook is CPU-heavy — and the
  // persistence axis threads prevFired sequentially per chat, so each combo re-scores every floor — but
  // this file is env-gated and never runs in the normal suite.
  it('grid-searches params on real floors and writes the report', { timeout: 600_000 }, () => {
    const { samples, chats, entries, scanDepth, pinsDeclared, varsMode } = collectSamples()
    if (samples.length === 0) {
      // eslint-disable-next-line no-console
      console.log('No usable (chat, floor) samples (need chats with ≥4 floors). Skipping.')
      return
    }
    const scenarios = samples.map((s) => s.scenario) // pinText resolved per floor (see collectSamples)
    const chatLabels = [...new Set(samples.map((s) => s.chatLabel))]

    // --- Pin-hit analysis: does the resolved location actually match entry keys, per floor? ---
    const pinHitsPerFloor = samples.map((s) => pinHitCount(s.scenario.books, s.scenario.pinText))
    const floorsWithPin = samples.filter((s) => s.scenario.pinText.length > 0).length
    const floorsWithPinHit = pinHitsPerFloor.filter((n) => n > 0).length
    const pinTotal = pinHitsPerFloor.reduce((a, b) => a + b, 0)
    const pinsMatter = pinHitsPerFloor.some((n) => n > 0)

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

    // --- Sequential prevFired threading. `samples` is already grouped by chat and ordered by floor. For a
    // given params, replay each chat's floors in order: floor i's fired set (bookName::entryIndex refs)
    // becomes floor i+1's prevFired UNDER THE SAME PARAMS; the first floor of each chat starts empty. This
    // is what activates the scorer's persistBoost axis. `e.fired` is already an EntryRef[] so we pass it
    // straight through (evaluate re-keys it as `${bookName}::${entryIndex}` internally). ---
    const threadedResults = (scns: Scenario[], p: ScoringParams): EvalResult[] => {
      const prevByChat: Record<string, EntryRef[]> = {}
      return scns.map((sc, i) => {
        const chat = samples[i].chatLabel
        const prevFired = prevByChat[chat] ?? []
        const e = evaluate({ ...sc, prevFired }, p)
        prevByChat[chat] = e.fired
        return e
      })
    }

    interface Stats {
      micro: MicroAgg
      firedPerFloor: number
      churn: number
    }
    const statsFrom = (results: EvalResult[]): Stats => {
      const byChat: Record<string, Array<Set<string>>> = {}
      for (const l of chatLabels) byChat[l] = []
      results.forEach((e, i) => byChat[samples[i].chatLabel].push(new Set(e.fired.map(refKey))))
      return {
        micro: microAggregate(results),
        firedPerFloor: mean(results.map((e) => e.firedCount)),
        churn: mean(chatLabels.map((l) => meanChurn(byChat[l])))
      }
    }
    // Scorer stats at params p, prevFired threaded sequentially per chat.
    const statsAt = (p: ScoringParams): Stats => statsFrom(threadedResults(scenarios, p))
    // Keyword baseline (segments+pins, RPT mode) stats — no params, no persistence, but a fired set per
    // floor so churn is still computable. prevFired is irrelevant to the unranked matcher.
    const keywordStats = (): Stats =>
      statsFrom(scenarios.map((sc) => evaluateKeywordBaseline(sc)))

    // --- Grid maxK × minScore × relCut × persistBoost (pinBoost fixed at 2.5; λ/hop at defaults) ---
    const combos: Array<{ params: ScoringParams; micro: MicroAgg }> = []
    for (const maxK of GRID.maxK)
      for (const minScore of GRID.minScore)
        for (const relCut of GRID.relCut)
          for (const persistBoost of GRID.persistBoost) {
            const params = {
              ...DEFAULT_SCORING_PARAMS,
              pinBoost: PIN_BOOST,
              maxK,
              minScore,
              relCut,
              persistBoost
            }
            combos.push({ params, micro: microAggregate(threadedResults(scenarios, params)) })
          }
    combos.sort((a, b) => b.micro.f1 - a.micro.f1 || b.micro.precision - a.micro.precision)
    const gridBest = combos[0]

    // --- Frontier: minScore/relCut fixed at the current defaults (0.6 / 0.35), sweep maxK × persistBoost.
    // This is the headline recall-vs-churn deliverable. ---
    const frontier: Array<{ maxK: number; persistBoost: number; stats: Stats }> = []
    for (const maxK of GRID.maxK)
      for (const persistBoost of GRID.persistBoost) {
        const params = {
          ...DEFAULT_SCORING_PARAMS,
          pinBoost: PIN_BOOST,
          maxK,
          minScore: 0.6,
          relCut: 0.35,
          persistBoost
        }
        frontier.push({ maxK, persistBoost, stats: statsAt(params) })
      }

    // --- Named comparisons: current defaults vs the synthetic-grid winner vs keyword baseline ---
    const currentDefaults = { ...DEFAULT_SCORING_PARAMS } // maxK4 min0.6 rel0.35 persist1, pinBoost 2.5
    const syntheticWinner = { ...DEFAULT_SCORING_PARAMS, maxK: 12, persistBoost: 1.5 } // min0.6 rel0.35
    const statsDefault = statsAt(currentDefaults)
    const statsWinner = statsAt(syntheticWinner)
    const statsKeyword = keywordStats()

    // eslint-disable-next-line no-console
    console.log(
      `\nSamples: ${chats} chat(s) × ${samples.length} (chat,floor), ${entries} entries, scanDepth=${scanDepth}, vars=${varsMode}, pinsDeclared=${pinsDeclared}` +
        `\nPin-hit entries: total=${pinTotal} mean/floor=${f3(mean(pinHitsPerFloor))} floorsWithPin=${floorsWithPin}/${samples.length} floorsWithPinHit=${floorsWithPinHit}` +
        `\nCurrent defaults (${paramStr(currentDefaults)}) P=${f3(statsDefault.micro.precision)} R=${f3(statsDefault.micro.recall)} F1=${f3(statsDefault.micro.f1)} fired/floor=${f3(statsDefault.firedPerFloor)} churn=${f3(statsDefault.churn)}` +
        `\nSynthetic winner (${paramStr(syntheticWinner)}) P=${f3(statsWinner.micro.precision)} R=${f3(statsWinner.micro.recall)} F1=${f3(statsWinner.micro.f1)} fired/floor=${f3(statsWinner.firedPerFloor)} churn=${f3(statsWinner.churn)}` +
        `\nKeyword (segments+pins) P=${f3(statsKeyword.micro.precision)} R=${f3(statsKeyword.micro.recall)} F1=${f3(statsKeyword.micro.f1)} fired/floor=${f3(statsKeyword.firedPerFloor)} churn=${f3(statsKeyword.churn)}` +
        `\nGrid best ${paramStr(gridBest.params)} F1=${f3(gridBest.micro.f1)}`
    )

    // --- Markdown report (aggregate numbers + anonymized labels ONLY — no card prose, no entry keys) ---
    const gridHeader = '| Rank | Params | Precision | Recall | F1 |\n|---|---|---|---|---|'
    const topRows = combos
      .slice(0, 10)
      .map((c, i) => `| ${i + 1} | ${paramStr(c.params)} | ${f3(c.micro.precision)} | ${f3(c.micro.recall)} | ${f3(c.micro.f1)} |`)
    const frontierRows = frontier.map(
      (r) =>
        `| ${r.maxK} | ${r.persistBoost} | ${f3(r.stats.micro.precision)} | ${f3(r.stats.micro.recall)} | ${f3(r.stats.micro.f1)} | ${f3(r.stats.firedPerFloor)} | ${f3(r.stats.churn)} |`
    )
    const cmpRow = (label: string, params: string, s: Stats): string =>
      `| ${label} | ${params} | ${f3(s.micro.precision)} | ${f3(s.micro.recall)} | ${f3(s.micro.f1)} | ${f3(s.firedPerFloor)} | ${f3(s.churn)} |`

    const doc = `# Lore-scoring real-data evaluation — persistence axis (2026-07-24)

**Status: PoC — debug window only; diagnostic, NOT a defaults decision.** This is the real-floor-data
replay extended to exercise the **persistence-bonus axis** (\`persistBoost\`) that the scorer gained in
\`loreScoring.ts\`. \`prevFired\` is threaded **sequentially per chat, in floor order**: the entries that
fired at floor i (keyed \`bookName::entryIndex\`) become the \`prevFired\` set for floor i+1 of the same
chat under the same params; the first floor of each chat starts from an empty set.

**The proxy is keyword-flavored and circular.** The label ("an enabled non-constant entry is relevant for
floor N iff one of its primary keys appears in the stored text of response N") rewards exactly the lexical
signal the scorer already keys on, so it CANNOT adjudicate a defaults change — it is a smoke test that the
codepath runs and a rough recall-vs-churn shape, nothing more. \`DEFAULT_SCORING_PARAMS\` is **NOT** changed
from these numbers.

Context pins are exercised: the replayed card declares one \`pin_paths\` entry (a location variable),
resolved **${varsMode === 'per-floor' ? 'per floor (the floor N-1 stat_data snapshot the generation of floor N would have seen)' : 'from the chat current vars (per-floor snapshots unavailable — STATIC pin)'}**.
λ/hop are held at defaults and **pinBoost is fixed at ${PIN_BOOST}** (the proxy cannot separate pinBoost
values — documented in the prior real-data doc); the grid sweeps maxK × minScore × relCut × persistBoost
(**${combos.length} combos**). Metrics are micro-aggregated P/R/F1 vs. the proxy; churn is the mean
floor-to-floor symmetric-difference of the fired set within a chat (same definition as the prior doc, so
numbers are comparable).

## Sample size + pin resolution

- Chats replayed (≥4 floors): **${chats}** · (chat, floor) samples: **${samples.length}** · entries: **${entries}**
- scanDepth: **${scanDepth}** · maxRecursion: **0** · vars mode: **${varsMode}** · pins declared: **${pinsDeclared}**
- Floors with a resolved pin block: **${floorsWithPin}/${samples.length}** · pin-hit entries: total **${pinTotal}**, mean **${f3(mean(pinHitsPerFloor))}/floor**, floors with ≥1 pin hit **${floorsWithPinHit}/${samples.length}**
  ${pinsMatter ? '(the location DOES match entry keys — the pin axis is genuinely exercised).' : '(**the location matches ZERO entry keys** — the pin axis is exercised in code only).'}

## Recall-vs-churn frontier (maxK × persistBoost, min=0.6 rel=0.35, pin=${PIN_BOOST}) — HEADLINE

| maxK | persistBoost | Precision | Recall | F1 | fired/floor | churn |
|---|---|---|---|---|---|---|
${frontierRows.join('\n')}

_Read down a maxK block: raising \`persistBoost\` should hold last-floor entries in place — trading a little
precision for lower churn (cache stability) at equal-or-better recall. Read across maxK: a larger cap lifts
recall at the cost of more fires (and more churn). The owner's defaults call is where on this surface the
recall gain stops being worth the churn/context cost._

## Named comparisons

| Config | Params | Precision | Recall | F1 | fired/floor | churn |
|---|---|---|---|---|---|---|
${cmpRow('Current defaults', paramStr(currentDefaults), statsDefault)}
${cmpRow('Synthetic-grid winner', paramStr(syntheticWinner), statsWinner)}
${cmpRow('Keyword baseline (segments+pins)', '—', statsKeyword)}

## Grid top 10 (by micro-F1; pinBoost fixed at ${PIN_BOOST})

${gridHeader}
${topRows.join('\n')}

_Grid best on this data: \`${paramStr(gridBest.params)}\` (F1 ${f3(gridBest.micro.f1)}). This is the proxy's
own optimum, NOT a recommendation — the proxy rewards fire-everything recall, so its F1 optimum drifts to a
high maxK / low floor that would blow up real context budget._

## Limitations

- **Proxy is circular.** "Relevant = key appears in the stored response" rewards the exact lexical signal
  the scorer keys on and mislabels both directions (needs-without-mention, mentions-without-need). It
  under-credits pins and persistence: an entry the model KNEW but did not re-name counts as a false
  positive, and a correctly-persisted entry that goes unmentioned for a floor is scored as noise.
- **Persistence is self-referential here.** \`prevFired\` is the scorer's OWN prior-floor output, not a
  ground-truth "should have persisted" set — so the churn numbers describe the scorer's self-consistency,
  which \`persistBoost\` mechanically improves; they do not prove the persisted entries were the right ones.
- **One pin path, one card, ${chats} chat(s).** A single location variable on a single ${entries}-entry
  book — a smoke signal that the persistence + pin codepaths run end-to-end, not a representative measure.
- **No recursion.** maxRecursion=0 (app default) — recursion-lifted retrieval is not measured.

_Diagnostic replay of local dev data; the proxy is too weak (and, for persistence, too circular) to retune
\`DEFAULT_SCORING_PARAMS\`._
`
    const outDir = path.join(process.cwd(), 'docs')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'lore-scoring-real-data-persist-2026-07-24.md'), doc)
    // eslint-disable-next-line no-console
    console.log(`\nReport written. Pins matter: ${pinsMatter ? 'YES' : 'NO'} · grid best ${paramStr(gridBest.params)}.`)
  })
})
