import { getSettings } from './settingsService'
import { getActivePreset } from './presetService'
import { getLorebookById } from './lorebookService'
import { getChat, getChatLorebookIds, appendFloor, truncateFloors } from './chatService'
import { getAllFloors, getFloor, saveFloor } from './floorService'
import { normalizeSwipes } from './swipeHelpers'
import { collectRenderMarkers, ChatMessage } from './promptBuilder'
import { maybeCompact } from './compactionService'
import { saveGlobals } from './templateService'
import { streamProvider, DeltaCallback } from './apiService'
import {
  parseMvuCommands,
  applyMvuCommands,
  applyJsonPatch,
  JsonPatchOp
} from '../parsers/mvuParser'
import { stripThinking } from '../parsers/contentParser'
import { log } from './logService'
import { FloorFile } from '../types/chat'
import { Lorebook } from '../types/character'
import { buildGenContext } from './generation/genContext'
import { recallMemory } from './generation/memoryRecall'
import { matchWorldInfo, assemblePrompt } from './generation/assemble'
import { callModel } from './generation/callModel'
import { parseResponse, computeMetrics } from './generation/parseResponse'
import { foldState, applyEvent } from './generation/foldState'

// Re-exported so existing consumers/tests (test/generationService.test.ts) keep working; the
// implementation now lives in generation/assemble.ts (its only real call site).
export { composeAddendum } from './generation/assemble'

// Re-exported so existing consumers/tests (test/generationService.test.ts) keep working; the
// implementation now lives in generation/foldState.ts (folded alongside computeMetrics's data).
export { applyEvent }

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
  // A new model turn legitimately re-fires MVU events; clear the write-back loop streak so a path
  // re-written once per turn never builds a false runaway streak across turns (WS-3).
  resetWriteLoopGuard(chatId)
  const ctx = buildGenContext(profileId, chatId, userAction)
  const { chat, settings, globals } = ctx

  const matchedEntries = matchWorldInfo(ctx)

  const memory = await recallMemory(ctx)

  const { sendMessages, params } = assemblePrompt(ctx, matchedEntries, memory.block)

  const controller = new AbortController()
  activeControllers.set(chatId, controller)
  let r: { raw: string; rawUsage: unknown; stopped: boolean } | null
  try {
    r = await callModel(ctx, sendMessages, params, onDelta, controller.signal)
  } finally {
    activeControllers.delete(chatId)
  }
  if (!r) return null
  const { raw, rawUsage } = r

  // Cache meter: compute this turn's metrics (proxy + provider usage) + the cumulative snapshot,
  // chaining from the previous floor. Persisted on the floor below; both UI surfaces derive from it.
  const turnMetrics = computeMetrics(ctx, sendMessages, raw, rawUsage)

  // The FULL raw response is stored (lossless) — reasoning/state strips + display regex are
  // applied at VIEW time (renderer) and history-assembly time, never baked into storage. We
  // only clean a COPY here to drive state extraction.
  const { parsed, mvu } = parseResponse(raw)

  // workingVars already holds any template setvar() mutations from this build;
  // apply this turn's rpt-events + MVU commands/patches + combat cue on top, then persist globals.
  const variables = foldState(ctx, parsed, mvu, raw)

  saveGlobals(profileId, globals)

  const now = new Date().toISOString()
  const floor: FloorFile = {
    floor: chat.floor_count,
    chat_id: chatId,
    timestamp: now,
    user_message: { content: userAction, timestamp: now },
    // Lossless: the complete AI output (incl. <thinking>, <UpdateVariable>, etc.) is stored.
    response: { content: raw, model: settings.api.model, provider: settings.api.provider },
    // The complete prompt that produced it, for full-fidelity inspection/replay.
    request: sendMessages,
    events: parsed.events,
    variables,
    metrics: turnMetrics
  }

  appendFloor(profileId, chatId, floor)
  // Episodic memory (docs/episodic-memory-design.md §7): fold aged-out turns into memories. Off
  // the hot path — the floor is already persisted and returned below. Fail-open; never blocks the
  // turn (maybeCompact swallows its own errors; the .catch is a belt-and-braces guard).
  void maybeCompact(profileId, chatId).catch((err) =>
    log('error', `memory: compaction error — ${err?.message || String(err)}`)
  )
  return floor
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

// Runaway write-back loop breaker (TIMING-INDEPENDENT). A card that writes a constantly-CHANGING value on
// its own update event (e.g. a `date` clock) re-triggers itself forever — every write is a real change, so
// the no-op guard can't catch it. We detect the runaway *signature*: the SAME set of changed paths written
// CONSECUTIVELY many times. A legitimate init chain touches DISTINCT paths (the signature changes each
// write, so the streak resets), and per-turn updates are spread across model folds — so only a true
// self-feedback loop accumulates a long streak. The streak is reset on every model fold
// (`generate()` → `resetWriteLoopGuard`), so a path legitimately re-written once per turn never accumulates
// a false streak across turns; a loop accumulates only WITHIN one inter-fold window (no AI turn to break it).
//
// WS-3 (2026-06-26): the previous guard was TIME-WINDOWED (≤400 ms between same-sig writes) and so MISSED a
// loop whose IPC round-trip is slower than the window — exactly the reported `date` clock. Removing the
// time dependence (count consecutive same-sig writes, reset per turn) catches the slow loop without
// false-positiving on legit per-turn updates. This is still a band-aid for the architectural divergence the
// WS-3 SPIKE found (RPT fires MVU `mag_variable_update_*` on the card's own write echoes; real MVU fires
// them only on the AI fold — MagVarUpdate source). The proper fix (tag change origin; fire events only on
// model-fold; delete this guard) remains DEFERRED pending in-app verify against 命定之诗 (whose live
// automation is loaded remotely, so the self-chain assumption can't be checked from the card files). See
// docs/structural-cleanup-log-2026-06-26.md Stage 13/15 + the note in shared/thRuntime/index.ts.
const writeLoopGuard = new Map<string, { sig: string; count: number }>()
const LOOP_MAX = 40 // consecutive same-signature writes (no model fold between) before we treat it as runaway

/** Reset the runaway-loop streak for a chat. Called at the start of each model turn (`generate`) so a path
 *  legitimately re-written once per turn never builds a false streak across turns — a real self-feedback
 *  loop (many consecutive same-sig writes with no AI turn between) still trips the guard within one turn. */
export const resetWriteLoopGuard = (chatId: string): void => {
  writeLoopGuard.delete(chatId)
}

/**
 * Register a write's changed-path signature against the per-chat runaway streak and report whether this
 * write should be DROPPED as a self-feedback loop. Drops once the SAME signature has been written more than
 * `LOOP_MAX` times CONSECUTIVELY (a different signature resets the streak; `resetWriteLoopGuard` clears it
 * each model turn). Pure w.r.t. the module's streak map — exported so the loop logic is unit-testable
 * without the DB. Returns `{ drop, count }` (count = the post-increment streak length).
 */
export const registerWriteSignature = (
  chatId: string,
  sig: string
): { drop: boolean; count: number } => {
  const g = writeLoopGuard.get(chatId)
  if (g && g.sig === sig) {
    g.count++
    return { drop: g.count > LOOP_MAX, count: g.count }
  }
  writeLoopGuard.set(chatId, { sig, count: 1 })
  return { drop: false, count: 1 }
}

/**
 * Variable WRITE-BACK bridge: apply JSONPatch ops to ONE floor's stat_data (the message
 * variables) and persist. This is the path by which native/script panel UI MODIFIES state
 * instead of only displaying it (a button, checkbox, or manual edit). Reuses the same
 * `applyJsonPatch` engine as the model's `<UpdateVariable>`, so author/user writes fold in
 * identically and survive a later re-evaluate. Returns the updated floor (or null if the
 * floor is gone / there are no ops / the write was a no-op or a suppressed runaway loop).
 * Targets a specific floor — the caller passes the latest.
 */
export const applyVariableOps = (
  profileId: string,
  chatId: string,
  floor: number,
  ops: JsonPatchOp[]
): FloorFile | null => {
  if (!Array.isArray(ops) || ops.length === 0) return null
  const f = getFloor(profileId, chatId, floor)
  if (!f) return null
  const sd: Record<string, unknown> =
    f.variables.stat_data && typeof f.variables.stat_data === 'object'
      ? (f.variables.stat_data as Record<string, unknown>)
      : {}
  const deltas = applyJsonPatch(sd, ops)
  // No-op guard: drop the write entirely when nothing actually changed (a card re-writing identical
  // values). Checked at the source (same object shapes) rather than relying on the event-side diff guard
  // surviving the multi-hop IPC round-trip.
  const changed = deltas.filter((d) => JSON.stringify(d.old) !== JSON.stringify(d.new))
  if (changed.length === 0) return null
  // Runaway-loop guard: a constantly-changing value hammered on the card's own event signature. Counts
  // CONSECUTIVE writes of the same changed-path signature (timing-independent); reset each model turn.
  const sig = changed
    .map((d) => d.path)
    .sort()
    .join('|')
  const loop = registerWriteSignature(chatId, sig)
  if (loop.drop) {
    if (loop.count === LOOP_MAX + 1)
      log(
        'info',
        `variable write-back — runaway loop on [${sig}] (floor ${floor}); suppressing the self-feedback ` +
          `write so it can't spin (${LOOP_MAX}+ consecutive same-path writes with no AI turn between — ` +
          `a card writing a changing value on its own update event)`
      )
    return null
  }
  f.variables = { ...f.variables, stat_data: sd, delta_data: deltas }
  saveFloor(profileId, chatId, f)
  log(
    'info',
    `variable write-back — floor ${floor}: ${changed.map((d) => d.path).join(', ')}` +
      (changed.length < ops.length ? ` (${ops.length - changed.length} no-op)` : '')
  )
  return f
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
