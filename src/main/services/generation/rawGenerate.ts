import { getSettings } from '../settingsService'
import { getActivePreset } from '../presetService'
import { getChat } from '../chatService'
import { getAllFloors } from '../floorService'
import { ChatMessage } from '../promptBuilder'
import { streamProvider, DeltaCallback } from '../apiService'
import { log } from '../logService'

/**
 * The abort surface + the raw one-off generation, extracted from generationService so LEAF
 * consumers (combatService/duelService narration, the tool nodes' transitive imports) don't
 * pull the whole turn orchestrator — that import produced a cycle once the builtin node
 * registry (which generationService loads) gained nodes that call the combat/duel services.
 * generationService re-exports everything here, so its public surface is unchanged.
 */

// In-flight generations keyed by chat, so the renderer can abort one to stop
// burning provider tokens. Shared by generate() and generateRaw().
export const activeControllers = new Map<string, AbortController>()

/** READ-ONLY: is a call that registers in `activeControllers` in flight — a full turn, or a bare
 *  `generateRaw` (combat adjudication, enemy turns, duel narration, a card script's TH generateRaw)?
 *  (Classic Narrator plan, Milestone 4 — one of the sources unioned into `hasActiveBackgroundWork()`.)
 *  NOT "any provider call": `callModel` deliberately leaves the controller lifecycle to `generate()`
 *  and never registers here, so `callModelResilient` callers (table backfill/refill, workflow nodes)
 *  are invisible to this accessor and are covered by their own sources. This map is also keyed per
 *  chat and SHARED with generate(), so it cannot replace the turn guard either: a raw call starting
 *  mid-turn overwrites the turn's entry and its `finally` then deletes the shared key. Both are
 *  unioned. Synchronous, no mutation exposed. */
export const hasActiveRawGeneration = (): boolean => activeControllers.size > 0

/** Abort the in-flight generation for a chat (if any). */
export const abortGeneration = (chatId: string): void => {
  activeControllers.get(chatId)?.abort()
}

/**
 * Custom one-off generation (TH-4 `generateRaw`). Builds a minimal message array from the
 * config — optional system prompt, optional recent history, and the user input — applies
 * sampler/max_tokens overrides over the active preset, and returns the raw text WITHOUT
 * persisting a floor. Because it never touches the chat transcript, it can't disturb the
 * L1–L4 prompt-cache layering of the real conversation. Aborts via the same controller map
 * as a normal turn (so `stopGeneration` cancels it too).
 */
export interface RawGenConfig {
  userInput?: string
  prompt?: string
  systemPrompt?: string
  /** Include this many most-recent floors as history (default 0 = fully raw). */
  maxChatHistory?: number
  maxTokens?: number
  /** Sampler parameter overrides merged over the active preset (temperature, top_p, …). */
  overrides?: Record<string, unknown>
}

export const generateRaw = async (
  profileId: string,
  chatId: string,
  config: RawGenConfig = {},
  onDelta: DeltaCallback = () => {}
): Promise<string> => {
  const settings = getSettings(profileId)
  const preset = getActivePreset(profileId)

  const messages: ChatMessage[] = []
  if (config.systemPrompt) messages.push({ role: 'system', content: String(config.systemPrompt) })
  const histN = Math.max(0, Number(config.maxChatHistory) || 0)
  if (histN > 0) {
    const chat = getChat(profileId, chatId)
    const floors = chat ? getAllFloors(profileId, chatId, chat.floor_count) : []
    for (const f of floors.slice(-histN)) {
      if (f.user_message.content) messages.push({ role: 'user', content: f.user_message.content })
      if (f.response.content) messages.push({ role: 'assistant', content: f.response.content })
    }
  }
  messages.push({ role: 'user', content: String(config.userInput ?? config.prompt ?? '') })

  const params = {
    ...preset.parameters,
    ...(config.overrides || {}),
    ...(config.maxTokens != null ? { max_tokens: config.maxTokens } : {})
  }

  const controller = new AbortController()
  activeControllers.set(chatId, controller)
  log('request', `→ generateRaw · ${messages.length} msg(s)`, messages)
  try {
    return await streamProvider(settings, messages, params, onDelta, controller.signal)
  } catch (err: any) {
    if (controller.signal.aborted) return ''
    log('error', '✗ generateRaw failed', err?.message || String(err))
    throw err
  } finally {
    activeControllers.delete(chatId)
  }
}
