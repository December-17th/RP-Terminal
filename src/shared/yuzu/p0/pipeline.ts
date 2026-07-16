import type { Scene } from './sceneDraftSchema'
import type { P0Context } from './fixtureContext'
import { buildSceneMessages, type ChatMessage } from './schemaPrompt'
import { buildRepairMessages } from './repair'
import { extractJson } from './extractJson'
import { FailureShape, mapExtractReason, observationsFromApplied, validateScene } from './validate'
import { parseInlineScene } from './inlineParse'
import { buildSceneMessagesInline, buildRepairMessagesInline } from './inlinePrompt'

/**
 * Project Yuzu WP-P0 — the wire-format STRATEGY seam.
 *
 * WP-P0 measures how reliably a provider returns a valid scene. There are two competing ways to put a
 * scene on the wire: one atomic JSON object (`jsonStrategy`) vs. a line-oriented command stream
 * (`inlineStrategy`, the YSS format). A `PipelineStrategy` bundles the three format-specific steps —
 * how to prompt, how to parse a reply into a Scene, and how to re-ask on failure — so `runP0Batch` can
 * drive EITHER format through the identical loop and judge both by the identical `validateScene`. That
 * is what makes the A/B fair.
 *
 * `parse` returns the reconstructed Scene (or a failure list) PLUS two side channels the record needs:
 *   - `observations`: shapes noted but not fatal (THINK_WRAPPED, FENCED, a skipped unknown YSS command)
 *   - `applied`:      the transform trail for the AttemptRecord (e.g. ['think','fence','slice'])
 * On the failure branch `failures` already folds the observations in (so the record's `failures` field
 * is byte-for-byte what the pre-strategy loop produced); on success the record uses `observations`.
 */

export type ParseResult =
  | { ok: true; scene: Scene; observations: FailureShape[]; applied: string[] }
  | {
      ok: false
      failures: FailureShape[]
      detail: string
      observations: FailureShape[]
      applied: string[]
    }

export interface PipelineStrategy {
  format: 'json' | 'inline'
  buildMessages(ctx: P0Context, lastError?: string): ChatMessage[]
  parse(raw: string, ctx: P0Context): ParseResult
  buildRepair(
    ctx: P0Context,
    priorRaw: string,
    failures: FailureShape[],
    detail: string
  ): ChatMessage[]
}

const uniq = (xs: FailureShape[]): FailureShape[] => [...new Set(xs)]

/**
 * JSON strategy — wraps the original extract → validate → repair path EXACTLY (this is the default, and
 * its behavior must stay identical to the pre-strategy loop). extractJson's `applied[]` is both kept as
 * the record's transform trail AND mapped to `observations` via `observationsFromApplied`.
 */
export const jsonStrategy: PipelineStrategy = {
  format: 'json',
  buildMessages: buildSceneMessages,
  buildRepair: buildRepairMessages,
  parse(raw, ctx) {
    const ex = extractJson(raw)
    const observations = observationsFromApplied(ex.applied)
    if (!ex.ok) {
      const failures = uniq([...observations, mapExtractReason(ex.reason)])
      return { ok: false, failures, detail: ex.error, observations, applied: ex.applied }
    }
    const v = validateScene(ex.value, ctx)
    if (v.ok) return { ok: true, scene: v.scene, observations, applied: ex.applied }
    const failures = uniq([...observations, ...v.failures])
    return { ok: false, failures, detail: v.detail, observations, applied: ex.applied }
  }
}

/** The inline path only ever strips a <think> block, so that is the whole transform trail. */
const inlineApplied = (observations: FailureShape[]): string[] =>
  observations.includes(FailureShape.THINK_WRAPPED) ? ['think'] : []

/**
 * Inline (YSS) strategy — wraps `parseInlineScene` (which itself runs the shared `validateScene`). Its
 * asymmetric leniency lives in the parser: unknown verbs/ids/effects become observations, not failures,
 * so they are folded into `failures` only on the branch where validation actually failed (matching the
 * JSON strategy's own observation-folding).
 */
export const inlineStrategy: PipelineStrategy = {
  format: 'inline',
  buildMessages: buildSceneMessagesInline,
  buildRepair: buildRepairMessagesInline,
  parse(raw, ctx) {
    const r = parseInlineScene(raw, ctx)
    const applied = inlineApplied(r.observations)
    if (r.ok) {
      return { ok: true, scene: r.scene, observations: r.observations, applied }
    }
    const failures = uniq([...r.observations, ...r.failures])
    return { ok: false, failures, detail: r.detail, observations: r.observations, applied }
  }
}
