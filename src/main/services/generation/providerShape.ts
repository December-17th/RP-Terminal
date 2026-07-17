import { systemToUser, mergeConsecutiveRoles, ChatMessage } from '../promptBuilder'
import { orderForProvider, isOpenAiCompatibleProvider } from '../apiService'
import { Settings } from '../../types/models'
import { log } from '../logService'
import type { RecordBuilder } from './executionRecord'

/**
 * The SINGLE provider-shaping seam (issue 10 / WP-1.4). Applies the ST-faithful provider-correctness
 * passes exactly once, at the provider-adapter boundary, to whatever message array a caller hands it:
 *
 *  (B) system→user — only on the OpenAI-compatible path + when opted in (`settings.generation.system_as_user`).
 *      Gemini-via-OpenAI handles a `system` role poorly; Anthropic/Gemini-native shape system via their own
 *      params, so those providers skip it. Runs BEFORE (A) so converted blocks merge with adjacent user turns.
 *  (A) merge consecutive same-role (default on) — coalesce a block split across adjacent same-role entries
 *      into one message.
 *  (C) provider ordering — end-on-user for strict OpenAI-compatible backends, but a trailing assistant
 *      prefill is kept last (orderForProvider).
 *
 * BOTH generation paths call this ONE function:
 *  • the default pipeline — `assemblePrompt` (assemble.ts) passes its record builder, so each stage that
 *    fires is journaled + logged;
 *  • the hand-authored `prompt.messages` / `merge.messages` workflow nodes — pass no journal, so shaping
 *    runs silently (no record entry, no log), exactly as before.
 *
 * When `journal` is present, each stage that actually changes the array is recorded as an `arrayStage`
 * entry (and logged) — the exact conditions/notes the inline copy in `assemble.ts` used, in the same
 * order, so the wire AND the execution record stay byte-identical to before this consolidation.
 */
export const providerShape = (
  settings: Settings,
  messages: ChatMessage[],
  journal?: RecordBuilder
): ChatMessage[] => {
  // (B) system→user (OpenAI-compatible + opt-in). systemToUser always runs when the guard passes; the
  //     log + journal fire only when it actually relabeled something.
  let assembled = messages
  if (settings.generation?.system_as_user && isOpenAiCompatibleProvider(settings.api.provider)) {
    const before = assembled.filter((m) => m.role === 'system').length
    assembled = systemToUser(assembled)
    if (before && journal) {
      log('info', `system→user: relabeled ${before} system message(s) (OpenAI-compatible path)`)
      journal.arrayStage(
        'system-as-user',
        assembled.length,
        assembled.length,
        `relabeled ${before} system message(s) (OpenAI-compatible path)`
      )
    }
  }

  // (A) merge consecutive same-role (default on).
  const merged =
    settings.generation?.merge_consecutive_roles !== false
      ? mergeConsecutiveRoles(assembled)
      : assembled
  if (merged.length !== assembled.length && journal) {
    log('info', `merged consecutive same-role messages: ${assembled.length} → ${merged.length}`)
    journal.arrayStage(
      'role-merge',
      assembled.length,
      merged.length,
      `coalesced ${assembled.length} → ${merged.length} same-role message(s)`
    )
  }

  // (C) provider ordering (end-on-user; a trailing assistant prefill is kept last so the model continues it).
  const sendMessages = orderForProvider(merged, settings.api.provider)
  if (sendMessages !== merged && journal) {
    journal.arrayStage(
      'provider-shape',
      merged.length,
      sendMessages.length,
      `${settings.api.provider} ordering (end-on-user)`
    )
  }

  return sendMessages
}
