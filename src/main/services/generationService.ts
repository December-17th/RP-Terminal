import { getSettings, resolveModeConfig } from './settingsService'
import { getActivePreset, getActivePresetId } from './presetService'
import { getCharacter } from './characterService'
import { getLorebookById, matchAcross } from './lorebookService'
import {
  getChat,
  getChatLorebookIds,
  getChatMode,
  getCachedWorldInfo,
  setCachedWorldInfo,
  appendFloor,
  truncateFloors
} from './chatService'
import { getAllFloors, getFloor, saveFloor } from './floorService'
import { normalizeSwipes } from './swipeHelpers'
import {
  buildPrompt,
  buildScanText,
  fitToBudget,
  collectRenderMarkers,
  ChatMessage
} from './promptBuilder'
import { getPromptRules } from './regexService'
import { selectMemories } from './retrievalService'
import { loadGlobals, saveGlobals } from './templateService'
import { streamProvider, orderForProvider, DeltaCallback, UsageCallback } from './apiService'
import { normalizeUsage, buildFloorMetrics } from './promptCacheMetrics'
import { parseContent, parseCombatStart, stripThinking, RPEvent } from '../parsers/contentParser'
import {
  parseMvuCommands,
  applyMvuCommands,
  applyJsonPatch,
  JsonPatchOp
} from '../parsers/mvuParser'
import { frozenVarsFor } from './cacheLayers'
import {
  lastMessageIndex,
  lastUserMessageIndex,
  lastCharMessageIndex
} from '../../shared/thRuntime/shapes'
import { log } from './logService'
import { FloorFile } from '../types/chat'
import { Lorebook, LorebookEntry, getRpExt } from '../types/character'

/**
 * Combine the FSM mode addendum with a World Card's custom agent prompts (Track S §3).
 * A card's `agent.prompts.system` is a world-level system instruction and applies in
 * every mode; a per-mode prompt (`agent.prompts[mode]`, e.g. `combat`) applies only when
 * the FSM is engaged. Returned as a single trimmed, newline-joined system addendum.
 */
export const composeAddendum = (
  agent: any,
  mode: string,
  fsmEnabled: boolean,
  modeAddendum: string
): string => {
  const prompts = agent?.prompts || {}
  return [
    fsmEnabled ? modeAddendum : '',
    typeof prompts.system === 'string' ? prompts.system : '',
    fsmEnabled && typeof prompts[mode] === 'string' ? prompts[mode] : ''
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Apply a single rpt-event to a mutable variables object (nested path set/add/remove). */
export const applyEvent = (vars: Record<string, any>, evt: RPEvent): void => {
  if (evt.type !== 'state') return
  const parts = evt.path.split('.')
  let obj = vars
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {}
    obj = obj[parts[i]]
  }
  const last = parts[parts.length - 1]
  if (evt.action === 'add') {
    obj[last] = (typeof obj[last] === 'number' ? obj[last] : 0) + Number(evt.value)
  } else if (evt.action === 'remove') {
    obj[last] = (typeof obj[last] === 'number' ? obj[last] : 0) - Number(evt.value)
  } else {
    obj[last] = evt.value
  }
}

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

  const card = getCharacter(profileId, chat.character_id)
  if (!card) throw new Error('Character card not found')

  const settings = getSettings(profileId)
  const preset = getActivePreset(profileId)
  // The FSM is on in 'manual' and 'agentic' agent modes (agentic adds auto-routing — TBD,
  // so it behaves like manual for now). It enables per-mode tuning (retrieval breadth,
  // output ceiling, system addendum) + L2 cache-on-transition. 'off' = classic: ST-style,
  // no FSM tuning, lore re-matched every turn (fully dynamic keywords).
  // TODO(agentic): when agent.mode === 'agentic', classify intent here and setChatMode().
  const fsmEnabled = settings.agent?.mode === 'manual' || settings.agent?.mode === 'agentic'
  const mode = getChatMode(profileId, chatId)
  const modeConfig = resolveModeConfig(settings, mode)
  // A session injects all its selected lorebooks; with none chosen it defaults to
  // the character's own lorebook (id == characterId), preserving prior behavior.
  const lorebookIds = getChatLorebookIds(profileId, chatId) ?? [chat.character_id]
  const lorebooks = lorebookIds
    .map((id) => getLorebookById(profileId, id))
    .filter((lb): lb is Lorebook => lb !== null)
  const floors = getAllFloors(profileId, chatId, chat.floor_count)

  // Seed the working variables from the latest floor; ST-Prompt-Template code in
  // authored content (getvar/setvar/…) reads and mutates these during the build.
  const lastFloor = floors[floors.length - 1]
  const workingVars: Record<string, any> = JSON.parse(JSON.stringify(lastFloor?.variables ?? {}))
  const globals = loadGlobals(profileId)
  const userName = settings.persona?.name || 'User'

  // Prompt-cache level (L1 Frozen Core when ≥1). The frozen snapshot is derived from the
  // FIRST floor's variables — constant across the session — so the frontier render is
  // byte-stable. 'partition' shows placeholders for state; 'diff' shows the floor-0 values.
  const cacheLevel = settings.cache?.level ?? 0
  const l1Mode = settings.cache?.l1_mode ?? 'partition'
  const floor0Vars = floors[0]?.variables ?? {}
  const frozenVars = cacheLevel >= 1 ? frozenVarsFor(l1Mode, floor0Vars) : {}

  const scanDepth = fsmEnabled
    ? (modeConfig.scan_depth ?? settings.lorebook?.scan_depth ?? 3)
    : (settings.lorebook?.scan_depth ?? 3)
  const maxRecursion = settings.lorebook?.max_recursion ?? 0
  const scanText = buildScanText(floors, userAction, scanDepth)

  // L2 world-info matching differs by mode:
  //  • Agentic — Phase H inc 2 cache: match once per FSM mode and reuse across turns
  //    within that mode, so the world-info block stays byte-stable for the provider
  //    prefix cache (Phase G). A transition / lorebook-selection change forces a re-match;
  //    by design new keywords raised mid-mode don't pull new lore until the next transition.
  //  • Classic — re-match every turn for fully dynamic keyword lore (ST behavior); any
  //    stale agentic cache is cleared so a later switch back to agentic starts fresh.
  let matchedEntries: LorebookEntry[]
  if (fsmEnabled) {
    const cached = getCachedWorldInfo(profileId, chatId)
    if (cached && cached.mode === mode) {
      matchedEntries = cached.entries
    } else {
      matchedEntries = matchAcross(lorebooks, scanText, Math.random, maxRecursion)
      setCachedWorldInfo(profileId, chatId, { mode, entries: matchedEntries })
      log(
        'info',
        `world info (re)matched for ${mode} mode — ${matchedEntries.length} entr${matchedEntries.length === 1 ? 'y' : 'ies'} cached`
      )
    }
  } else {
    matchedEntries = matchAcross(lorebooks, scanText, Math.random, maxRecursion)
    setCachedWorldInfo(profileId, chatId, null)
  }
  // Diagnostic: surface lorebook reach so an empty/unattached book is obvious in the Logs panel
  // (0 books = nothing attached; books but 0 matched = no constant entries + no keyword hit).
  const loreEntryCount = lorebooks.reduce((n, lb) => n + lb.entries.length, 0)
  log(
    'info',
    `lorebook: ${lorebooks.length} book(s) / ${loreEntryCount} entr${loreEntryCount === 1 ? 'y' : 'ies'} → ${matchedEntries.length} matched · ids=[${lorebookIds.join(', ') || 'none'}]`
  )

  // Episodic memory (docs/episodic-memory-design.md §8): recall relevant past memories into the
  // ephemeral tail. No-op when memory is disabled; at cache level 0 it just adds tail context.
  const memory = selectMemories(profileId, chatId, scanText, settings)
  if (memory.rows.length) {
    log('info', `memory: ${memory.rows.length} recalled (${memory.block.length} chars) → tail`)
  }

  const built = buildPrompt({
    card,
    preset,
    lorebooks,
    floors,
    userAction,
    userName,
    persona: {
      description: settings.persona?.description || '',
      inject: settings.persona?.inject !== false,
      depth: settings.persona?.depth ?? null
    },
    scanDepth,
    maxRecursion,
    matchedEntries,
    promptRegex: getPromptRules(profileId, {
      cardId: chat.character_id,
      chatId,
      presetId: getActivePresetId(profileId)
    }),
    cacheLevel,
    l1Mode,
    frozenVars,
    memoryBlock: memory.block,
    // FSM mode addendum + the World Card's custom agent prompts (system + per-mode).
    modeAddendum: composeAddendum(getRpExt(card)?.agent, mode, fsmEnabled, modeConfig.addendum),
    template: {
      // EJS engine on/off (settings toggle). When off, evalTemplate strips tags instead of running them;
      // {{macros}} still expand (they share vars/globals below).
      enabled: settings.templates?.enabled !== false,
      vars: workingVars,
      globals,
      constants: {
        userName,
        charName: card.data.name || 'Character',
        assistantName: card.data.name || 'Character',
        lastUserMessage: userAction,
        lastCharMessage: lastFloor?.response.content || '',
        // SillyTavern message-index globals (ST-Prompt-Template). The pending user action counts as the
        // last message, so on the opening turn lastMessageId === 1 (presets gate "is this the opening?" on it).
        lastMessageId: lastMessageIndex(floors, !!userAction.trim()),
        lastUserMessageId: lastUserMessageIndex(floors, !!userAction.trim()),
        lastCharMessageId: lastCharMessageIndex(floors),
        chatId,
        characterId: chat.character_id,
        runType: 'generate'
      },
      // TH-3 read-only template accessors (getchar/getwi/getMessageHistory/…).
      data: {
        charData: card.data as Record<string, unknown>,
        worldInfo: matchedEntries.map((e) => ({ name: e.comment || '', content: e.content })),
        messages: floors.map((f) => ({
          user: f.user_message.content,
          assistant: f.response.content
        })),
        chatName: card.data.name || '',
        presetName: preset.name,
        presetPrompts: preset.prompts.map((p) => ({
          name: p.name,
          identifier: p.identifier,
          content: p.content
        }))
      }
    }
  })

  // Trim oldest history to stay under the configured context budget.
  const budget = settings.generation?.max_context_tokens || 32000
  const { messages, dropped } = fitToBudget(built, budget)
  if (dropped > 0) {
    log('info', `context budget ${budget} tok — trimmed ${dropped} oldest message(s)`)
  }

  // Agentic mode caps the output ceiling at the FSM mode's limit (e.g. Combat is terse),
  // never exceeding the preset's own max_tokens. Classic mode uses the preset value as-is.
  const presetMax = preset.parameters.max_tokens
  const maxTokens = fsmEnabled
    ? presetMax != null
      ? Math.min(presetMax, modeConfig.max_output_tokens)
      : modeConfig.max_output_tokens
    : presetMax
  const params = { ...preset.parameters, max_tokens: maxTokens }

  // The exact array sent to the API (provider-specific ordering: end-on-user for strict OpenAI-compatible
  // backends, but a trailing assistant prefill is kept last so the model continues it). Logged + stored, so
  // the `request` log is a FAITHFUL representation of what went over the wire.
  const sendMessages = orderForProvider(messages, settings.api.provider)

  log(
    'request',
    `→ ${settings.api.provider} · ${settings.api.model || '(no model)'} · ${fsmEnabled ? `${mode} mode` : 'classic'} · ${sendMessages.length} msgs · ${settings.api.endpoint || '(default endpoint)'}`,
    sendMessages
  )

  let rawUsage: unknown = null
  const onUsage: UsageCallback = (u) => {
    rawUsage = u
  }

  const controller = new AbortController()
  activeControllers.set(chatId, controller)

  let raw: string
  try {
    raw = await streamProvider(settings, sendMessages, params, onDelta, controller.signal, onUsage)
  } catch (err: any) {
    if (controller.signal.aborted) {
      log('info', '⏹ generation stopped by user')
      return null
    }
    log('error', `✗ provider call failed`, err?.message || String(err))
    throw err
  } finally {
    activeControllers.delete(chatId)
  }

  const stopped = controller.signal.aborted
  // Stopped with nothing generated: don't persist an empty floor.
  if (stopped && !raw.trim()) {
    log('info', '⏹ generation stopped (no text)')
    return null
  }

  log('response', `← ${raw.length} chars${stopped ? ' (stopped)' : ''}`, raw)

  // Cache meter: compute this turn's metrics (proxy + provider usage) + the cumulative snapshot,
  // chaining from the previous floor (its stored `request` is the proxy anchor; its cumulative is
  // the prior tally). Persisted on the floor below; both UI surfaces derive from it.
  const turnMetrics = buildFloorMetrics({
    messages: sendMessages,
    prevMessages: (lastFloor?.request as ChatMessage[] | undefined) ?? null,
    usage: normalizeUsage(settings.api.provider, rawUsage),
    provider: settings.api.provider,
    model: settings.api.model,
    cacheLevel,
    l1Mode,
    ts: new Date().toISOString(),
    responseText: raw,
    prevCumulative: lastFloor?.metrics?.cumulative ?? null
  })
  log(
    'info',
    `cache — stable prefix ${turnMetrics.turn.proxyTokens}/${turnMetrics.turn.promptTokens} tok (${Math.round(turnMetrics.turn.proxyPct)}%)`
  )

  // The FULL raw response is stored (lossless) — reasoning/state strips + display regex are
  // applied at VIEW time (renderer) and history-assembly time, never baked into storage. We
  // only clean a COPY here to drive state extraction (drop <thinking> first so a stray
  // "<UpdateVariable>" mention in the reasoning can't make the MVU stripper eat the narrative).
  const cleaned = stripThinking(raw)
  const parsed = parseContent(cleaned)
  // MVU (Track R): parse <UpdateVariable> commands into stat_data, recording this turn's
  // deltas. Reads the cleaned copy for extraction only — the FULL response is what's stored.
  const mvu = parseMvuCommands(parsed.text)

  // workingVars already holds any template setvar() mutations from this build;
  // apply this turn's rpt-events on top, then persist global vars.
  const variables = workingVars
  for (const evt of parsed.events) applyEvent(variables, evt)
  if (mvu.commands.length || mvu.patches.length) {
    if (typeof variables.stat_data !== 'object' || variables.stat_data === null) {
      variables.stat_data = {}
    }
    const sd = variables.stat_data as Record<string, any>
    // Both MVU dialects target stat_data: classic `_.set(...)` and the `<JSONPatch>` form.
    const deltas = [
      ...(mvu.commands.length ? applyMvuCommands(sd, mvu.commands) : []),
      ...(mvu.patches.length ? applyJsonPatch(sd, mvu.patches) : [])
    ]
    variables.delta_data = deltas
    log(
      'info',
      `MVU — ${mvu.commands.length} cmd + ${mvu.patches.length} patch → ${deltas.length} delta(s) on stat_data`
    )
  }
  // Combat (Track Combat / P7): if the model signalled a fight, stash the cue on this
  // floor's vars so the chat can surface an "Enter Combat" affordance. The tag itself is
  // stripped at view time (responseView), never baked into storage.
  const combatCue = parseCombatStart(parsed.text).cue
  if (combatCue) variables.combat_cue = combatCue

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

/**
 * Variable WRITE-BACK bridge: apply JSONPatch ops to ONE floor's stat_data (the message
 * variables) and persist. This is the path by which native/script panel UI MODIFIES state
 * instead of only displaying it (a button, checkbox, or manual edit). Reuses the same
 * `applyJsonPatch` engine as the model's `<UpdateVariable>`, so author/user writes fold in
 * identically and survive a later re-evaluate. Returns the updated floor (or null if the
 * floor is gone / there are no ops). Targets a specific floor — the caller passes the latest.
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
  f.variables = { ...f.variables, stat_data: sd, delta_data: deltas }
  saveFloor(profileId, chatId, f)
  log('info', `variable write-back — applied ${ops.length} op(s) to floor ${floor}`)
  return f
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
