import { getSettings } from './settingsService'
import { getActivePreset } from './presetService'
import { getCharacter } from './characterService'
import { getCharacterLorebook } from './lorebookService'
import { getChat, appendFloor, truncateFloors } from './chatService'
import { getAllFloors, getFloor } from './floorService'
import { buildPrompt, fitToBudget } from './promptBuilder'
import { streamProvider, DeltaCallback } from './apiService'
import { parseContent, RPEvent } from '../parsers/contentParser'
import { log } from './logService'
import { FloorFile } from '../types/chat'

/** Apply a single rpt-event to a mutable variables object (nested path set/add/remove). */
const applyEvent = (vars: Record<string, any>, evt: RPEvent): void => {
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
  const lorebook = getCharacterLorebook(profileId, chat.character_id)
  const floors = getAllFloors(profileId, chatId, chat.floor_count)

  const built = buildPrompt({
    card,
    preset,
    lorebook,
    floors,
    userAction,
    userName: settings.persona?.name || 'User'
  })

  // Trim oldest history to stay under the configured context budget.
  const budget = settings.generation?.max_context_tokens || 32000
  const { messages, dropped } = fitToBudget(built, budget)
  if (dropped > 0) {
    log('info', `context budget ${budget} tok — trimmed ${dropped} oldest message(s)`)
  }

  log(
    'request',
    `→ ${settings.api.provider} · ${settings.api.model || '(no model)'} · ${messages.length} msgs · ${settings.api.endpoint || '(default endpoint)'}`,
    messages
  )

  const controller = new AbortController()
  activeControllers.set(chatId, controller)

  let raw: string
  try {
    raw = await streamProvider(settings, messages, preset.parameters, onDelta, controller.signal)
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

  // Carry forward the latest variables and apply this turn's events.
  const prevVars = floors.length > 0 ? floors[floors.length - 1].variables : {}
  const variables: Record<string, any> = JSON.parse(JSON.stringify(prevVars))
  for (const evt of parsed.events) applyEvent(variables, evt)

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
