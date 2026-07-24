import { IpcMain } from 'electron'
import { openDebugWindow } from '../services/debugWindowService'
import { buildGenContext } from '../services/generation/genContext'
import { buildScanText, buildPinBlock, resolvePins } from '../services/promptBuilder'
import { matchAcrossTraced } from '../services/lorebookService'
import { scoreLoreEntries, type ScoreSegment } from '../services/loreScoring'
import { cleanForHistory } from '../../shared/responseView'
import { getRpExt } from '../types/character'
import {
  DEFAULT_SCORING_PARAMS,
  type RetrievalPreviewResponse,
  type ScoringParams
} from '../../shared/retrievalTrace'

/** Merge a caller's partial scoring params over the defaults, sanitizing bad values (non-finite/negative
 *  → default; maxK floored to an int ≥ 0; relCut clamped to [0,1]). Debug-only, so this stays permissive. */
const sanitizeScoringParams = (raw?: Partial<ScoringParams>): ScoringParams => {
  const p = raw ?? {}
  const pos = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d
  const maxKRaw = p.maxK
  const maxK =
    typeof maxKRaw === 'number' && Number.isFinite(maxKRaw) && maxKRaw >= 0
      ? Math.floor(maxKRaw)
      : DEFAULT_SCORING_PARAMS.maxK
  const relCutRaw = p.relCut
  const relCut =
    typeof relCutRaw === 'number' && Number.isFinite(relCutRaw)
      ? Math.min(1, Math.max(0, relCutRaw))
      : DEFAULT_SCORING_PARAMS.relCut
  return {
    lambda: pos(p.lambda, DEFAULT_SCORING_PARAMS.lambda),
    hopDecay: pos(p.hopDecay, DEFAULT_SCORING_PARAMS.hopDecay),
    pinBoost: pos(p.pinBoost, DEFAULT_SCORING_PARAMS.pinBoost),
    maxK,
    minScore: pos(p.minScore, DEFAULT_SCORING_PARAMS.minScore),
    relCut,
    persistBoost:
      typeof p.persistBoost === 'number' && Number.isFinite(p.persistBoost) && p.persistBoost >= 1
        ? p.persistBoost
        : DEFAULT_SCORING_PARAMS.persistBoost
  }
}

/** IPC for the separate Debug window: open/focus (WP-D1) + lorebook retrieval dry-run (WP-D2). */
export const registerDebugIpc = (ipcMain: IpcMain): void => {
  // The TopStrip button asks main to open/focus the window.
  ipcMain.handle('open-debug-window', () => openDebugWindow())

  /**
   * WP-D2: a side-effect-free dry-run of lorebook retrieval for one chat. It gathers the exact scan
   * inputs a real turn would (`buildGenContext` — reads floors/lorebooks/card/settings/vars, NO model
   * call, NO writes), then runs the matcher twice: RPT retrieval scans `base + [PINS]`, the ST-keyword
   * baseline scans `base` alone. Returns both traces so the viewer can diff them per entry. Read-only:
   * no journaling, no epoch bumps.
   */
  ipcMain.handle(
    'retrieval-preview',
    (
      _event,
      profileId: string,
      chatId: string,
      userAction?: string,
      extraPinPaths?: string[],
      scoring?: Partial<ScoringParams>
    ): RetrievalPreviewResponse => {
      const action = userAction ?? ''
      let ctx
      try {
        // buildGenContext THROWS on a missing chat/card — treat either as not-found.
        ctx = buildGenContext(profileId, chatId, action, 'normal')
      } catch {
        return { ok: false, code: 'not-found' }
      }
      const base = buildScanText(ctx.floors, action, ctx.scanDepth)
      // Card-declared pins, then the viewer's ad-hoc "try pin paths" (trimmed, deduped, and with any
      // path already declared removed). Dry-run only — the combined list is never persisted to the card.
      const declared = getRpExt(ctx.card)?.pin_paths ?? []
      const extra = [
        ...new Set((Array.isArray(extraPinPaths) ? extraPinPaths : []).map((p) => p.trim()).filter(Boolean))
      ].filter((p) => !declared.includes(p))
      const combined = [...declared, ...extra]
      const pinBlock = buildPinBlock(ctx.workingVars, combined)
      const resolvedPins = resolvePins(ctx.workingVars, combined).map((r) => ({
        path: r.path,
        value: r.value,
        ...(extra.includes(r.path) ? { adhoc: true as const } : {})
      }))
      const books = ctx.lorebooks.map((lorebook) => ({ name: lorebook.name, lorebook }))
      // rng: () => 0 → the probability roll always passes (0*100 < probability for any probability > 0),
      // so the viewer shows what WOULD qualify and the two runs are stably comparable.
      const rpt = matchAcrossTraced(books, base + pinBlock, () => 0, ctx.maxRecursion)
      const baseline = matchAcrossTraced(books, base, () => 0, ctx.maxRecursion)

      // Deterministic-scorer PoC (debug-only). Segments mirror buildScanText's floor slice/extraction so
      // the scorer and the matcher see the same text, but tagged by recency depth (0 = pending action,
      // 1 = newest floor, …). The pin block is passed separately as the pin-evidence source.
      const scoringParams = sanitizeScoringParams(scoring)
      const segments: ScoreSegment[] = []
      if (action) segments.push({ depth: 0, text: action })
      const floorSlice = ctx.floors.slice(-Math.max(1, ctx.scanDepth))
      for (let i = floorSlice.length - 1, depth = 1; i >= 0; i--, depth++) {
        const f = floorSlice[i]
        const text = [f.user_message.content, cleanForHistory(f.response.content)]
          .filter(Boolean)
          .join('\n')
        if (text) segments.push({ depth, text })
      }
      // Persistence axis (hysteresis): the scorer boosts entries that fired on the PREVIOUS floor. We
      // reconstruct that floor's fired set with a mirror dry-run over the history shifted one floor back —
      // drop the newest floor from the slice, omit the pending user action, and resolve pins from the
      // floor-N-1 variables snapshot (the state the previous floor's generation actually saw), exactly as
      // the real-data harness does (test/loreScoringRealData.test.ts L75-91, L164-168). A chat with fewer
      // than two floors has no previous floor, so the set stays empty and no row is marked persisted.
      let prevFired: ReadonlySet<string> = new Set<string>()
      if (ctx.floors.length >= 2) {
        const prevSlice = ctx.floors.slice(0, -1).slice(-Math.max(1, ctx.scanDepth))
        const prevSegments: ScoreSegment[] = []
        for (let i = prevSlice.length - 1, depth = 1; i >= 0; i--, depth++) {
          const f = prevSlice[i]
          const text = [f.user_message.content, cleanForHistory(f.response.content)]
            .filter(Boolean)
            .join('\n')
          if (text) prevSegments.push({ depth, text })
        }
        // Pins as of the previous floor = the floor-N-1 variables snapshot (second-newest floor's vars).
        const prevPinVars = ctx.floors[ctx.floors.length - 2]?.variables ?? {}
        const prevPinBlock = buildPinBlock(prevPinVars as Record<string, any>, combined)
        const prevScored = scoreLoreEntries(books, prevSegments, prevPinBlock, scoringParams)
        prevFired = new Set(
          prevScored.filter((s) => s.fired).map((s) => `${s.bookName}::${s.entryIndex}`)
        )
      }

      const scored = scoreLoreEntries(books, segments, pinBlock, scoringParams, prevFired)

      return {
        ok: true,
        baseScanText: base,
        pinBlock,
        scanDepth: ctx.scanDepth,
        maxRecursion: ctx.maxRecursion,
        pinPaths: declared,
        extraPinPaths: extra,
        resolvedPins,
        rpt: rpt.trace,
        baseline: baseline.trace,
        lorebookNames: ctx.lorebooks.map((lb) => lb.name),
        scored,
        scoringParams,
        prevFiredCount: prevFired.size
      }
    }
  )
}
