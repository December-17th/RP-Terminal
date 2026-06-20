import { getSettings, resolveModeConfig } from './settingsService'
import { getActivePreset } from './presetService'
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
import { getAllFloors, getFloor } from './floorService'
import { buildPrompt, buildScanText, fitToBudget } from './promptBuilder'
import { getPromptRules } from './regexService'
import { loadGlobals, saveGlobals } from './templateService'
import { streamProvider, DeltaCallback } from './apiService'
import { parseContent, RPEvent } from '../parsers/contentParser'
import { log } from './logService'
import { FloorFile } from '../types/chat'
import { Lorebook, LorebookEntry } from '../types/character'

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
    promptRegex: getPromptRules(profileId),
    modeAddendum: fsmEnabled ? modeConfig.addendum : '',
    template: {
      vars: workingVars,
      globals,
      constants: {
        userName,
        charName: card.data.name || 'Character',
        lastUserMessage: userAction,
        lastCharMessage: lastFloor?.response.content || ''
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

  log(
    'request',
    `→ ${settings.api.provider} · ${settings.api.model || '(no model)'} · ${fsmEnabled ? `${mode} mode` : 'classic'} · ${messages.length} msgs · ${settings.api.endpoint || '(default endpoint)'}`,
    messages
  )

  const controller = new AbortController()
  activeControllers.set(chatId, controller)

  let raw: string
  try {
    raw = await streamProvider(settings, messages, params, onDelta, controller.signal)
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

  // Extract rpt-event state tags. The RAW response is stored — display regex
  // (markdownOnly beautification) is applied at render time, not persisted, so
  // history sent back to the model stays in the model's own output format.
  const parsed = parseContent(raw)

  // workingVars already holds any template setvar() mutations from this build;
  // apply this turn's rpt-events on top, then persist global vars.
  const variables = workingVars
  for (const evt of parsed.events) applyEvent(variables, evt)
  saveGlobals(profileId, globals)

  const now = new Date().toISOString()
  const floor: FloorFile = {
    floor: chat.floor_count,
    chat_id: chatId,
    timestamp: now,
    user_message: { content: userAction, timestamp: now },
    response: { content: parsed.text, model: settings.api.model, provider: settings.api.provider },
    events: parsed.events,
    variables
  }

  appendFloor(profileId, chatId, floor)
  return floor
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
