import { getSettings } from './settingsService'
import { getActivePreset } from './presetService'
import { getLorebookById } from './lorebookService'
import { getChat, getChatLorebookIds, truncateFloors } from './chatService'
import { getCharacter } from './characterService'
import { getAllFloors, getFloor, saveFloor } from './floorService'
import { normalizeSwipes } from './swipeHelpers'
import { collectRenderMarkers, ChatMessage } from './promptBuilder'
import { streamProvider, DeltaCallback } from './apiService'
import { parseMvuCommands, applyMvuCommands, applyJsonPatch } from '../parsers/mvuParser'
import { stripThinking } from '../parsers/contentParser'
import { log } from './logService'
import { FloorFile } from '../types/chat'
import { Lorebook } from '../types/character'
import { applyEvent } from './generation/foldState'
import { resetWriteLoopGuard } from './generation/varsWrite'
import { buildTurnContext } from './nodes/turnContext'
import { builtinRegistry } from './nodes/builtin'
import { DEFAULT_GRAPH } from './nodes/builtin/defaultGraph'
import { runWorkflow } from './workflowEngine'

// Re-exported so existing consumers/tests (test/generationService.test.ts) keep working; the
// implementation now lives in generation/assemble.ts (its only real call site).
export { composeAddendum } from './generation/assemble'

// Re-exported so existing consumers/tests (test/generationService.test.ts) keep working; the
// implementation now lives in generation/foldState.ts (folded alongside computeMetrics's data).
export { applyEvent }

// Re-exported so existing consumers/tests (test/generationService.test.ts, node tests) keep
// working; the implementation now lives in generation/varsWrite.ts (a leaf module — the
// mvu.set node needs applyVariableOps, and importing generationService back from a node would
// create an import cycle since generationService imports nodes/builtin).
export {
  resetWriteLoopGuard,
  registerWriteSignature,
  applyVariableOps
} from './generation/varsWrite'

/**
 * Run one full turn: assemble the prompt, call the model, post-process (regex →
 * tag parse), fold state events into the running variables, persist a new floor,
 * and return it. All orchestration lives here so the renderer just calls one IPC.
 */
// In-flight generations keyed by chat, so the renderer can abort one to stop
// burning provider tokens.
const activeControllers = new Map<string, AbortController>()

/** Abort the in-flight generation for a chat (if any). */
export const abortGeneration = (chatId: string): void => {
  activeControllers.get(chatId)?.abort()
}

export const generate = async (
  profileId: string,
  chatId: string,
  userAction: string,
  onDelta: DeltaCallback = () => {}
): Promise<FloorFile | null> => {
  const chat = getChat(profileId, chatId)
  if (!chat) throw new Error('Chat session not found')

  const _card = getCharacter(profileId, chat.character_id)
  if (!_card) throw new Error('Character card not found')

  // A new model turn legitimately re-fires MVU events; clear the write-back loop streak so a path
  // re-written once per turn never builds a false runaway streak across turns (WS-3).
  resetWriteLoopGuard(chatId)

  const controller = new AbortController()
  activeControllers.set(chatId, controller)
  try {
    const ctx = buildTurnContext({
      profileId,
      chatId,
      // TODO(Task 5): resolve the chat/world/global workflow selection instead of this literal.
      workflowId: 'default',
      userAction,
      signal: controller.signal,
      onDelta
    })
    const res = await runWorkflow(DEFAULT_GRAPH, builtinRegistry, ctx)
    // A pre-phase node failure (provider error, assembly throw, …) reaches us as a fatal
    // RESULT, not a rejection — re-surface it (spec §10: unwired + failed ⇒ the turn aborts
    // with the error surfaced). Without this a hard failure returns null and reads exactly
    // like a user Stop: no renderer error banner, the action text silently lost.
    if (res.error) throw new Error(res.error.message)
    if (!res.ok || res.aborted) return null
    const floor = res.outputs.get('write')?.floor as FloorFile | undefined
    return floor ?? null
  } finally {
    activeControllers.delete(chatId)
  }
}

/** Active render-marker templates ([RENDER:*]) for a session — the renderer evals + wraps each message. */
export const getRenderMarkers = (
  profileId: string,
  chatId: string
): { before: string[]; after: string[] } => {
  const chat = getChat(profileId, chatId)
  if (!chat) return { before: [], after: [] }
  const ids = getChatLorebookIds(profileId, chatId) ?? [chat.character_id]
  const lorebooks = ids
    .map((id) => getLorebookById(profileId, id))
    .filter((b): b is Lorebook => !!b)
  return collectRenderMarkers(lorebooks)
}

/**
 * Re-derive every floor's MVU `stat_data` by replaying its stored `<UpdateVariable>` updates from
 * scratch — enabled by lossless storage. Lets the user re-apply variable updates after a parser
 * change WITHOUT a costly regeneration: no new API call, the narrative is untouched, only the
 * derived state is recomputed. Cumulative (floor N's stat_data = replay of floors 0..N). Returns
 * the updated floors.
 */
export const reevaluateVariables = (profileId: string, chatId: string): FloorFile[] => {
  const floors = getAllFloors(profileId, chatId)
  const stat: Record<string, unknown> = {}
  for (const f of floors) {
    const mvu = parseMvuCommands(stripThinking(f.response.content))
    const deltas = [
      ...(mvu.commands.length ? applyMvuCommands(stat, mvu.commands) : []),
      ...(mvu.patches.length ? applyJsonPatch(stat, mvu.patches) : [])
    ]
    f.variables = {
      ...f.variables,
      stat_data: JSON.parse(JSON.stringify(stat)),
      delta_data: deltas
    }
    saveFloor(profileId, chatId, f)
  }
  log('info', `MVU re-evaluate — replayed ${floors.length} floor(s); rebuilt stat_data`)
  return floors
}

/** Pure: return a copy of the floor with stat_data replaced and delta_data cleared (a manual whole-doc
 *  edit has no AI-turn delta). Other variables + floor fields are preserved. */
export const withStatData = (floor: FloorFile, statData: unknown): FloorFile => ({
  ...floor,
  variables: { ...floor.variables, stat_data: statData, delta_data: [] }
})

/** Replace a floor's stat_data wholesale (the Variables-view editor's write path) and persist. */
export const setFloorStatData = (
  profileId: string,
  chatId: string,
  floor: number,
  statData: unknown
): FloorFile | null => {
  const f = getFloor(profileId, chatId, floor)
  if (!f) return null
  const updated = withStatData(f, statData)
  saveFloor(profileId, chatId, updated)
  return updated
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

/**
 * Image-generation hook (TH-4). No image provider is wired yet, so this is a logged
 * stub that returns null; the API surface exists so scripts/cards can call it and
 * degrade gracefully until a provider is configured.
 */
export const generateImage = async (_profileId: string, prompt: string): Promise<string | null> => {
  log('info', `image generation requested (no provider configured): ${String(prompt).slice(0, 80)}`)
  return null
}

/**
 * Re-roll the latest turn: drop the last floor and generate again from the same
 * user action. Refuses to regenerate the opening greeting (it has no action).
 */
export const regenerate = async (
  profileId: string,
  chatId: string,
  onDelta: DeltaCallback = () => {}
): Promise<FloorFile | null> => {
  const chat = getChat(profileId, chatId)
  if (!chat || chat.floor_count === 0) throw new Error('Nothing to regenerate')

  const lastIndex = chat.floor_count - 1
  const last = getFloor(profileId, chatId, lastIndex)
  if (!last) throw new Error('Last floor missing')
  if (!last.user_message.content) throw new Error('Cannot regenerate the opening greeting')

  truncateFloors(profileId, chatId, lastIndex)
  return generate(profileId, chatId, last.user_message.content, onDelta)
}

/**
 * Generate an additional response for the latest turn and store it as a NEW swipe
 * (alternate) on that floor, without discarding the existing alternates (TH-2). Like
 * regenerate, but the prior responses are preserved and the new one becomes active.
 */
export const generateSwipe = async (
  profileId: string,
  chatId: string,
  onDelta: DeltaCallback = () => {}
): Promise<FloorFile | null> => {
  const chat = getChat(profileId, chatId)
  if (!chat || chat.floor_count === 0) throw new Error('Nothing to swipe')

  const lastIndex = chat.floor_count - 1
  const last = getFloor(profileId, chatId, lastIndex)
  if (!last) throw new Error('Last floor missing')
  if (!last.user_message.content) throw new Error('Cannot swipe the opening greeting')

  // Capture the existing alternates before the re-roll drops the floor.
  const prior = normalizeSwipes(last.swipes, last.response.content, last.swipe_id).swipes

  truncateFloors(profileId, chatId, lastIndex)
  const fresh = await generate(profileId, chatId, last.user_message.content, onDelta)
  if (!fresh) {
    // Aborted / empty — restore the original floor so the swipe attempt loses nothing.
    saveFloor(profileId, chatId, last)
    return getFloor(profileId, chatId, lastIndex)
  }

  // Append the new response to the prior alternates and make it the active swipe.
  const swipes = [...prior, fresh.response.content]
  fresh.swipes = swipes
  fresh.swipe_id = swipes.length - 1
  saveFloor(profileId, chatId, fresh)
  return fresh
}
