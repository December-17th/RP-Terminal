import type { JsonObject, JsonValue } from './types'

/**
 * PREPROCESS SKIP CONVENTION (formatVersion-2 self-gating).
 *
 * A formatVersion-2 `processing.preprocess` script normally returns the reshaped input object. To
 * instead abort the run BEFORE any provider/LLM dispatch — an in-game-time gate deciding "nothing to
 * do this turn" — it returns this sentinel object verbatim:
 *
 *     return { __rpt_skip: true }              // or { __rpt_skip: true, reason: '...' }
 *
 * Semantics (enforced in the Invocation Runtime, NOT here): the run aborts with a distinct `skipped`
 * outcome, produces NO run record, and does NOT advance the floor-commit trigger cadence
 * (`latestRunFloor`). A skip is "not a run". The optional `reason` is surfaced in the preprocess logs.
 *
 * The sentinel is detected BEFORE `inputSchema` validation, so it is deliberately exempt from the
 * Agent's declared input contract.
 */
export const PREPROCESS_SKIP_MARKER = '__rpt_skip' as const

/** The skip sentinel a preprocess returns: `{ __rpt_skip: true }`, optionally with a `reason` string.
 *  Typed as a JsonObject so it stays assignable to the processor's JsonValue result. */
export type PreprocessSkipSignal = JsonObject & { [PREPROCESS_SKIP_MARKER]: true }

export const isPreprocessSkipSignal = (
  value: JsonValue | undefined
): value is PreprocessSkipSignal =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  value[PREPROCESS_SKIP_MARKER] === true
