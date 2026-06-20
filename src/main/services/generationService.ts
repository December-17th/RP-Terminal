import fs from 'fs'
import path from 'path'
import { getSettings } from './settingsService'
import { getPreset } from './presetService'
import { getCharacter } from './characterService'
import { getCharacterLorebook } from './lorebookService'
import { getChat, getChatsDir, appendFloor, truncateFloors } from './chatService'
import { getAllFloors, getFloor } from './floorService'
import { buildPrompt } from './promptBuilder'
import { streamProvider, DeltaCallback } from './apiService'
import { applyRegexRules, loadRegexRules, StRegexRule } from '../parsers/stRegexEngine'
import { parseContent, RPEvent } from '../parsers/contentParser'
import { log } from './logService'
import { FloorFile } from '../types/chat'

/** Load every regex rule file under profiles/{id}/regex/ (empty if none). */
const loadProfileRegexRules = (profileId: string): StRegexRule[] => {
  const dir = path.join(getChatsDir(profileId), '..', 'regex')
  if (!fs.existsSync(dir)) return []
  const rules: StRegexRule[] = []
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.json')) rules.push(...loadRegexRules(path.join(dir, file)))
  }
  return rules
}

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
export const generate = async (
  profileId: string,
  chatId: string,
  userAction: string,
  onDelta: DeltaCallback = () => {}
): Promise<FloorFile> => {
  const chat = getChat(profileId, chatId)
  if (!chat) throw new Error('Chat session not found')

  const card = getCharacter(profileId, chat.character_id)
  if (!card) throw new Error('Character card not found')

  const settings = getSettings(profileId)
  const preset = getPreset(profileId)
  const lorebook = getCharacterLorebook(profileId, chat.character_id)
  const floors = getAllFloors(profileId, chatId, chat.floor_count)

  const messages = buildPrompt({
    card,
    preset,
    lorebook,
    floors,
    userAction,
    userName: settings.persona?.name || 'User'
  })

  log(
    'request',
    `→ ${settings.api.provider} · ${settings.api.model || '(no model)'} · ${messages.length} msgs · ${settings.api.endpoint || '(default endpoint)'}`,
    messages
  )

  let raw: string
  try {
    raw = await streamProvider(settings, messages, preset.parameters, onDelta)
  } catch (err: any) {
    log('error', `✗ provider call failed`, err?.message || String(err))
    throw err
  }

  log('response', `← ${raw.length} chars`, raw)

  // Stage 2: ST regex rules. Stage 3: rpt-event extraction.
  const regexed = applyRegexRules(raw, loadProfileRegexRules(profileId), 'text')
  const parsed = parseContent(regexed)

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
): Promise<FloorFile> => {
  const chat = getChat(profileId, chatId)
  if (!chat || chat.floor_count === 0) throw new Error('Nothing to regenerate')

  const lastIndex = chat.floor_count - 1
  const last = getFloor(profileId, chatId, lastIndex)
  if (!last) throw new Error('Last floor missing')
  if (!last.user_message.content) throw new Error('Cannot regenerate the opening greeting')

  truncateFloors(profileId, chatId, lastIndex)
  return generate(profileId, chatId, last.user_message.content, onDelta)
}
