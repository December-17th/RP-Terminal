import type { DispatchTransform } from './promptArtifact'

/**
 * Per-chat registry of pre-dispatch mutation hooks (issue 19 / ADR 0017). A high-trust TavernHelper
 * script that registers a `CHAT_COMPLETION_PROMPT_READY`-analogue late hook lands here; the generation
 * node reads the chat's hooks at the 18e dispatch seam, applies them, and delta-records each mutation
 * onto the execution record (`applyDispatchTransforms` / `appendDispatchEntries` in `promptArtifact.ts`).
 *
 * Empty by default, so the standard generation path composes ZERO hooks and stays byte-identical — the
 * parity contract. It only fills when a high-trust script registers one.
 *
 * TODO(F2/F3 — tavernhelper-docs-spec §3): the cross-realm bridge that carries a live WCV high-trust
 * script's late-hook listener into this main-side registry (and the exact TH event name + whether the
 * payload is mutated in place vs replaced by the return) awaits the F2/F3 black-box fixtures. This module
 * is the seam's main-side home so that wiring has one obvious place to land.
 */
const hooksByChat = new Map<string, DispatchTransform[]>()

/** Register a pre-dispatch hook for a chat. Returns an unregister function (TH `eventOn` handle shape). */
export const registerDispatchHook = (chatId: string, hook: DispatchTransform): (() => void) => {
  const list = hooksByChat.get(chatId) ?? []
  list.push(hook)
  hooksByChat.set(chatId, list)
  return () => {
    const cur = hooksByChat.get(chatId)
    if (!cur) return
    const next = cur.filter((h) => h !== hook)
    if (next.length) hooksByChat.set(chatId, next)
    else hooksByChat.delete(chatId)
  }
}

/** The pre-dispatch hooks registered for a chat (empty array when none). */
export const getDispatchHooks = (chatId: string): DispatchTransform[] => hooksByChat.get(chatId) ?? []

/** Drop every hook for a chat (e.g. on chat close / card teardown). */
export const clearDispatchHooks = (chatId: string): void => {
  hooksByChat.delete(chatId)
}
