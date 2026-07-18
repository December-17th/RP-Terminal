import { systemToUser, mergeConsecutiveRoles, squashSystemMessages } from '../promptMessageShaping'
import type { ChatMessage } from '../promptTypes'
import { orderForProvider, isOpenAiCompatibleProvider } from '../apiService'
import { Settings } from '../../types/models'
import { log } from '../logService'
import type { RecordBuilder } from './executionRecord'
import { chatSquash, type ChatSquashConfig } from '../../../shared/spreset'

/**
 * The SINGLE provider-shaping seam (issue 10 / WP-1.4). Applies the ST-faithful provider-correctness
 * passes exactly once, at the provider-adapter boundary, to whatever message array a caller hands it:
 *
 *  (B) system→user — only on the OpenAI-compatible path + when opted in (`settings.generation.system_as_user`).
 *      Gemini-via-OpenAI handles a `system` role poorly; Anthropic/Gemini-native shape system via their own
 *      params, so those providers skip it. Runs BEFORE (A) so converted blocks merge with adjacent user turns.
 *  (A) system-message coalescing. Native presets (and every caller that doesn't opt in) use RPT's
 *      merge-ALL-adjacent-same-role (`mergeConsecutiveRoles`, default on) — coalescing a block split
 *      across adjacent same-role entries into one message. An IMPORTED ST preset that carries
 *      `squash_system_messages: true` instead uses ST's SELECTIVE squash (`squashSystemMessages`,
 *      openai.js:3827): consecutive UNNAMED system messages only, empties dropped, protected control
 *      identifiers preserved — ST 1.18.0 parity for that preset. The two are mutually exclusive (ST has
 *      no merge-all), and squash runs independent of `merge_consecutive_roles`.
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
  journal?: RecordBuilder,
  /**
   * Stage (A) selector. `squashSystemMessages: true` — set by `assemblePrompt` when the ACTIVE preset
   * is an imported ST preset with `squash_system_messages: true` — runs ST's selective squash instead
   * of merge-all. Absent / false (native presets + every workflow-node caller) keeps merge-all, so the
   * existing wire output is byte-identical (parity gate). A tri-state is deliberate: a native preset
   * never carries the flag (undefined → merge-all), so native behavior can never regress.
   */
  opts?: {
    squashSystemMessages?: boolean
    /**
     * SPreset ChatSquash (issue 16 / WP-2.6). When present + `config.enabled`, stage (A) runs the
     * preset's OWN role-based adjacent-merge (`chatSquash`) INSTEAD of ST squash / merge-all — a third,
     * mutually-exclusive coalescing mode. `expand` macro-expands the affixes. Absent / disabled → the
     * existing squash/merge branch (parity). ChatSquash's `squashed_post_script` `eval` is never run
     * here (surfaced as an import diagnostic instead — ADR 0017).
     */
    chatSquash?: { config: ChatSquashConfig; expand: (s: string) => string }
  }
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

  // (A) system-message coalescing — SPreset ChatSquash (its own role-merge) > ST selective squash for a
  //     squashing import > RPT's merge-all. The three are mutually exclusive (a preset picks one path).
  let merged: ChatMessage[]
  if (opts?.chatSquash?.config?.enabled) {
    // SPreset ChatSquash (issue 16): role-based adjacent merge with affixes/separators. Distinct from the
    // native merge-all AND ST's selective squash. Runs regardless of `merge_consecutive_roles`.
    merged = chatSquash(assembled, opts.chatSquash.config, opts.chatSquash.expand)
    if (journal) {
      log('info', `SPreset ChatSquash: ${assembled.length} → ${merged.length} message(s)`)
      journal.arrayStage(
        'chat-squash',
        assembled.length,
        merged.length,
        `SPreset ChatSquash: ${assembled.length} → ${merged.length} message(s)`
      )
    }
  } else if (opts?.squashSystemMessages) {
    // ST 1.18.0 squash (openai.js:3827): consecutive UNNAMED system messages merged with '\n', empty
    // system messages dropped, protected control identifiers preserved. Runs regardless of
    // `merge_consecutive_roles` (ST has no such setting) and REPLACES merge-all (never both).
    merged = squashSystemMessages(assembled)
    if (merged.length !== assembled.length && journal) {
      log('info', `ST system-message squash: ${assembled.length} → ${merged.length}`)
      journal.arrayStage(
        'squash',
        assembled.length,
        merged.length,
        `ST squash: coalesced/dropped ${assembled.length} → ${merged.length} system message(s)`
      )
    }
  } else {
    // Native (and workflow-node) path: merge ALL adjacent same-role messages (default on).
    merged =
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
