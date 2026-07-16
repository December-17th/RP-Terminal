import { buildSceneMessages, type ChatMessage } from './schemaPrompt'
import type { P0Context } from './fixtureContext'
import type { FailureShape } from './validate'
import { appendRepairTurn } from './promptShared'

/**
 * Project Yuzu WP-P0 — the single bounded corrective re-ask.
 *
 * Mirrors the app's self-correcting write pattern (resilientCall `correctiveMessages` /
 * tableMaintainerLoop `correctiveMessage`): re-send the original scene instruction, echo the model's
 * failed reply as the assistant turn (keeps role alternation provider-correct), then a short user turn
 * quoting exactly what was wrong. Deliberately terse — one shot, no negotiation.
 */
export const buildRepairMessages = (
  ctx: P0Context,
  priorRaw: string,
  failures: FailureShape[],
  detail: string
): ChatMessage[] => {
  return appendRepairTurn(
    buildSceneMessages(ctx),
    priorRaw,
    failures,
    detail,
    'Reply again with ONE JSON object only — no prose, no markdown fence, no <think> — that fixes the above and matches the schema and the allowed asset ids exactly.'
  )
}
