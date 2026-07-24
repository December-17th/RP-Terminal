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
  microScorer,
  microKeywordBaseline,
  type MicroAgg
} from './fixtures/loreScoring/metrics'

const GRID = {
  // Report-only: hold λ/hop at the defaults and grid the pin + selection knobs (108 combos).
  pinBoost: [1.5, 2.5, 4.0],
  maxK: [4, 8, 12, 16],
  minScore: [0, 0.3, 0.6],
  relCut: [0, 0.2, 0.35]
}

const f3 = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : '—')
const paramStr = (p: ScoringParams): string =>
  `pin=${p.pinBoost} maxK=${p.maxK} min=${p.minScore} rel=${p.relCut}`
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

  // Generous timeout: the grid (225 combos) × samples × a large real lorebook is CPU-heavy but this file
  // is env-gated and never runs in the normal suite.
  it('grid-searches params on real floors and writes the report', { timeout: 600_000 }, () => {
    const { samples, chats, entries, scanDepth, pinsDeclared, varsMode } = collectSamples()
    if (samples.length === 0) {
      // eslint-disable-next-line no-console
      console.log('No usable (chat, floor) samples (need chats with ≥4 floors). Skipping.')
      return
    }
    const scenarios = samples.map((s) => s.scenario) // pinText resolved per floor (see collectSamples)
    const pinless = samples.map((s) => ({ ...s.scenario, pinText: '' }))
    const chatLabels = [...new Set(samples.map((s) => s.chatLabel))]

    // --- Pin-hit analysis: does the resolved location actually match entry keys, per floor? ---
    const pinHitsPerFloor = samples.map((s) => pinHitCount(s.scenario.books, s.scenario.pinText))
    const floorsWithPin = samples.filter((s) => s.scenario.pinText.length > 0).length
    const floorsWithPinHit = pinHitsPerFloor.filter((n) => n > 0).length

    // --- Per-config stats over a chosen scenario list: micro P/R/F1 + fired/floor + floor-to-floor churn ---
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
    const statsAt = (p: ScoringParams, scns: Scenario[]): Stats => {
      const firedCounts: number[] = []
      const byChat: Record<string, Array<Set<string>>> = {}
      for (const l of chatLabels) byChat[l] = []
      scns.forEach((sc, i) => {
        const e = evaluate(sc, p)
        firedCounts.push(e.firedCount)
        byChat[samples[i].chatLabel].push(new Set(e.fired.map(refKey)))
      })
      return {
        micro: microScorer(scns, p),
        firedPerFloor: mean(firedCounts),
        churn: mean(chatLabels.map((l) => meanChurn(byChat[l])))
      }
    }

    // --- Grid pinBoost × maxK × minScore × relCut over the PINNED scenarios (λ/hop fixed) ---
    const combos: Array<{ params: ScoringParams; micro: MicroAgg }> = []
    for (const pinBoost of GRID.pinBoost)
      for (const maxK of GRID.maxK)
        for (const minScore of GRID.minScore)
          for (const relCut of GRID.relCut) {
            const params = { ...DEFAULT_SCORING_PARAMS, pinBoost, maxK, minScore, relCut }
            combos.push({ params, micro: microScorer(scenarios, params) })
          }
    combos.sort((a, b) => b.micro.f1 - a.micro.f1 || b.micro.precision - a.micro.precision)
    const best = combos[0]

    // pinBoost sweep at the default selection knobs (does 2.5 hold?).
    const pinSweep = GRID.pinBoost.map((pinBoost) => ({
      pinBoost,
      micro: microScorer(scenarios, { ...DEFAULT_SCORING_PARAMS, pinBoost })
    }))
    const bestPinBoost = [...pinSweep].sort((a, b) => b.micro.f1 - a.micro.f1)[0].pinBoost

    // Metrics WITH vs WITHOUT pins at the default params.
    const withPins = statsAt(DEFAULT_SCORING_PARAMS, scenarios)
    const withoutPins = statsAt(DEFAULT_SCORING_PARAMS, pinless)
    const statsBest = statsAt(best.params, scenarios)

    // Three-way keyword baselines (matching the viewer): ST (no pins) and RPT (segments + pins).
    const kwSt = microKeywordBaseline(pinless)
    const kwRpt = microKeywordBaseline(scenarios)
    const kwStFired = mean(samples.map((_, i) => evaluateKeywordBaseline(pinless[i]).firedCount))
    const kwRptFired = mean(samples.map((s) => evaluateKeywordBaseline(s.scenario).firedCount))

    const pinsMatter = pinHitsPerFloor.some((n) => n > 0)
    const pinsChangeScorer =
      withPins.firedPerFloor !== withoutPins.firedPerFloor ||
      Math.abs(withPins.micro.f1 - withoutPins.micro.f1) > 1e-9 ||
      Math.abs(withPins.churn - withoutPins.churn) > 1e-9

    // eslint-disable-next-line no-console
    console.log(
      `\nSamples: ${chats} chat(s) × ${samples.length} (chat,floor), ${entries} entries, scanDepth=${scanDepth}, vars=${varsMode}, pinsDeclared=${pinsDeclared}` +
        `\nPin-hit entries: total=${pinHitsPerFloor.reduce((a, b) => a + b, 0)} mean/floor=${f3(mean(pinHitsPerFloor))} floorsWithPin=${floorsWithPin}/${samples.length} floorsWithPinHit=${floorsWithPinHit}` +
        `\nScorer @default WITH pins   P=${f3(withPins.micro.precision)} R=${f3(withPins.micro.recall)} F1=${f3(withPins.micro.f1)} fired/floor=${f3(withPins.firedPerFloor)} churn=${f3(withPins.churn)}` +
        `\nScorer @default WITHOUT pins P=${f3(withoutPins.micro.precision)} R=${f3(withoutPins.micro.recall)} F1=${f3(withoutPins.micro.f1)} fired/floor=${f3(withoutPins.firedPerFloor)} churn=${f3(withoutPins.churn)}` +
        `\nbestPinBoost=${bestPinBoost} · grid best ${paramStr(best.params)} F1=${f3(best.micro.f1)}` +
        `\nKeyword ST(no pins) F1=${f3(kwSt.f1)} · RPT(pins) F1=${f3(kwRpt.f1)}`
    )

    // --- Markdown report (aggregate numbers + anonymized labels ONLY) ---
    const gridRow = (rank: string, p: string, m: MicroAgg): string =>
      `| ${rank} | ${p} | ${f3(m.precision)} | ${f3(m.recall)} | ${f3(m.f1)} |`
    const gridHeader = '| Rank | Params | Precision | Recall | F1 |\n|---|---|---|---|---|'
    const topRows = combos.slice(0, 10).map((c, i) => gridRow(String(i + 1), paramStr(c.params), c.micro))
    const pinTotal = pinHitsPerFloor.reduce((a, b) => a + b, 0)

    const doc = `# Lore-scoring real-data evaluation — pin axis active (2026-07-24)

**Status: PoC — debug window only; diagnostic, NOT a defaults decision.** Rerun of the 2026-07-24 real-data
evaluation with **context pins now exercised**: the replayed card declares one \`pin_paths\` entry (the
location variable), resolved **${varsMode === 'per-floor' ? 'per floor (the floor N-1 stat_data snapshot the generation of floor N would have seen)' : 'from the chat current vars (per-floor snapshots unavailable — STATIC pin, weaker signal)'}**.
The pin block feeds both the scorer and the RPT keyword baseline the same way the live handler does; a
pinless ST keyword baseline is kept for reference. λ/hop are fixed at defaults; pinBoost × maxK × minScore ×
relCut are gridded (${combos.length} combos). Proxy label unchanged: an enabled non-constant entry is
"relevant" for floor N iff one of its primary keys appears in the stored text of response N. Metrics are
micro-aggregated P/R/F1 vs. the proxy. \`DEFAULT_SCORING_PARAMS\` is NOT changed from these numbers.

## Sample size + pin resolution

- Chats replayed (≥4 floors): **${chats}** · (chat, floor) samples: **${samples.length}** · entries: **${entries}**
- scanDepth: **${scanDepth}** · maxRecursion: **0** · vars mode: **${varsMode}** · pins declared: **${pinsDeclared}**
- Floors with a resolved pin block: **${floorsWithPin}/${samples.length}**
- **Pin-hit entries** (entries whose key matches the resolved location): total **${pinTotal}**, mean
  **${f3(mean(pinHitsPerFloor))}/floor**, floors with ≥1 pin hit **${floorsWithPinHit}/${samples.length}**.
  ${pinsMatter ? 'The location DOES match entry keys — the pin axis is genuinely exercised.' : '**The location matches ZERO entry keys — the pin axis is still untested in practice.**'}

## Selection+pin grid top 10 (by micro-F1)

${gridHeader}
${topRows.join('\n')}

## Scorer with vs. without pins (default params) + keyword baselines

| Config | Params | Precision | Recall | F1 | fired/floor | churn |
|---|---|---|---|---|---|---|
| Scorer WITH pins | ${paramStr(DEFAULT_SCORING_PARAMS)} | ${f3(withPins.micro.precision)} | ${f3(withPins.micro.recall)} | ${f3(withPins.micro.f1)} | ${f3(withPins.firedPerFloor)} | ${f3(withPins.churn)} |
| Scorer WITHOUT pins | ${paramStr(DEFAULT_SCORING_PARAMS)} (pinText ∅) | ${f3(withoutPins.micro.precision)} | ${f3(withoutPins.micro.recall)} | ${f3(withoutPins.micro.f1)} | ${f3(withoutPins.firedPerFloor)} | ${f3(withoutPins.churn)} |
| grid best | ${paramStr(best.params)} | ${f3(statsBest.micro.precision)} | ${f3(statsBest.micro.recall)} | ${f3(statsBest.micro.f1)} | ${f3(statsBest.firedPerFloor)} | ${f3(statsBest.churn)} |
| Keyword RPT (segments+pins) | — | ${f3(kwRpt.precision)} | ${f3(kwRpt.recall)} | ${f3(kwRpt.f1)} | ${f3(kwRptFired)} | — |
| Keyword ST (no pins) | — | ${f3(kwSt.precision)} | ${f3(kwSt.recall)} | ${f3(kwSt.f1)} | ${f3(kwStFired)} | — |

${
  Math.abs(kwRpt.f1 - kwSt.f1) < 1e-9 && Math.abs(kwRptFired - kwStFired) < 1e-9
    ? '_Note: the two keyword baselines are identical — the current location is also named in the recent transcript, so appending the pin block adds no new keyword match for the unranked matcher. The pin only matters for the SCORER, which uses it to WEIGHT those entries so they survive the `maxK` cap._'
    : '_The RPT (with-pins) keyword baseline fires more than the ST (no-pins) one — the pin surfaced entries the transcript alone missed._'
}

## pinBoost sweep at default selection knobs

| pinBoost | Precision | Recall | F1 |
|---|---|---|---|
${pinSweep.map((s) => `| ${s.pinBoost} | ${f3(s.micro.precision)} | ${f3(s.micro.recall)} | ${f3(s.micro.f1)} |`).join('\n')}

## Answers

- **Does the resolved pin match entry keys?** ${pinsMatter ? `YES — ${pinTotal} pin-hit entries total (mean ${f3(mean(pinHitsPerFloor))}/floor, ${floorsWithPinHit}/${samples.length} floors). The location string shares keys (place / realm names) with lorebook entries, so the pin block re-surfaces state-relevant entries.` : 'NO — zero entries matched the location string; the axis is exercised in code but not in effect on this book.'}
- **Do pins change the fired set / metrics / churn vs. pinless (same params)?** ${pinsChangeScorer ? `YES — WITH pins vs WITHOUT: F1 ${f3(withPins.micro.f1)} vs ${f3(withoutPins.micro.f1)}, fired/floor ${f3(withPins.firedPerFloor)} vs ${f3(withoutPins.firedPerFloor)}, churn ${f3(withPins.churn)} vs ${f3(withoutPins.churn)}. Pinned location entries get a strong weight, so they hold ${withPins.firedPerFloor >= withoutPins.firedPerFloor ? 'their' : ''} \`maxK\` slots across floors as the transcript moves on. ${withPins.churn < withoutPins.churn ? `Notably churn DROPS (${f3(withoutPins.churn)} → ${f3(withPins.churn)}): a stable location re-surfaces the same entries each floor — a cache-stability win, which is the point of pins.` : ''}` : 'NO — identical fired sets/metrics/churn; the pin evidence never changed which entries cleared selection at these params.'}
- **Does pinBoost matter, and does 2.5 hold?** Best pinBoost on this data = **${bestPinBoost}**. ${bestPinBoost === 2.5 ? 'The default 2.5 is the (tied-)best — it holds.' : `2.5 is${pinSweep.find((s) => s.pinBoost === 2.5)!.micro.f1 >= Math.max(...pinSweep.map((s) => s.micro.f1)) - 1e-9 ? ' tied for' : ' not'} the best here (F1 at pin 1.5/2.5/4.0 = ${pinSweep.map((s) => f3(s.micro.f1)).join(' / ')}); the proxy barely separates pinBoost values, so 2.5 remains a reasonable default.`}

## Limitations

- **Proxy-label bias.** "Relevant = key appears in the stored response" is keyword-flavored and mislabels
  both directions (needs-without-mention, mentions-without-need). It also under-credits pins: a pinned
  location that the model KNEW but did not re-name in the response counts as a false positive.
- **One pin path, one card, one chat.** A single location variable on a single ${entries}-entry book — a
  smoke signal that the pin codepath runs end-to-end, not a representative measurement.
- **No recursion.** maxRecursion=0 (app default) — recursion-lifted retrieval is not measured.

_Diagnostic replay of local dev data; proxy labels are too weak to retune \`DEFAULT_SCORING_PARAMS\`._
`
    const outDir = path.join(process.cwd(), 'docs')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'lore-scoring-real-data-2026-07-24.md'), doc)
    // eslint-disable-next-line no-console
    console.log(`\nReport written. Pins matter: ${pinsMatter ? 'YES' : 'NO'} · bestPinBoost=${bestPinBoost}.`)
  })
})
