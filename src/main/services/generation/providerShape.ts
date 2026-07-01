import { systemToUser, mergeConsecutiveRoles, ChatMessage } from '../promptBuilder'
import { orderForProvider, isOpenAiCompatibleProvider } from '../apiService'
import { Settings } from '../../types/models'

/**
 * Provider-correctness passes for HAND-AUTHORED message lists (workflow `prompt.messages` /
 * `merge.messages` — spec §8): the same system→user / merge-consecutive / provider-order
 * sequence `assemblePrompt` applies to the default pipeline (assemble.ts:207-234), minus the
 * budget-trim and logging. assemble keeps its own inline copy deliberately — folding it onto
 * this helper is a parity-sensitive refactor for a later phase.
 */
export const providerShape = (settings: Settings, messages: ChatMessage[]): ChatMessage[] => {
  let out = messages
  if (settings.generation?.system_as_user && isOpenAiCompatibleProvider(settings.api.provider)) {
    out = systemToUser(out)
  }
  if (settings.generation?.merge_consecutive_roles !== false) {
    out = mergeConsecutiveRoles(out)
  }
  return orderForProvider(out, settings.api.provider)
}
