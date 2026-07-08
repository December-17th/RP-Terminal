// Shared post-combat narration plumbing (grid combat + STS duel). Extracted from combatService so
// both native combat modes narrate + fold MVU consequences identically ("one surface"). Text/prompt
// builders live in shared/combat (pure); THIS module does the model-agnostic chat write + MVU fold.

import { appendFloor, getChat } from './chatService'
import { getAllFloors } from './floorService'
import { getSettings } from './settingsService'
import { getCharacter } from './characterService'
import { getRpExt } from '../types/character'
import { type CombatBundle } from '../../shared/combat/bundle'
import { clone } from '../../shared/objectPath'
import { parseMvuCommands, applyMvuCommands, applyJsonPatch } from '../parsers/mvuParser'

/** Fold a narration response's `<UpdateVariable>` / `<JSONPatch>` consequences into a
 *  floor's `stat_data` (mirrors generate()'s fold), so injuries/deaths/loot persist. */
export const foldNarrationMvu = (variables: Record<string, any>, text: string): void => {
  const mvu = parseMvuCommands(text)
  if (!mvu.commands.length && !mvu.patches.length) return
  if (typeof variables.stat_data !== 'object' || variables.stat_data === null)
    variables.stat_data = {}
  const sd = variables.stat_data as Record<string, any>
  if (mvu.commands.length) applyMvuCommands(sd, mvu.commands)
  if (mvu.patches.length) applyJsonPatch(sd, mvu.patches)
}

/** Resolve the narration steering prompt, honoring (in order) the card's `combat` bundle
 *  (`narration_prompt`), the user's `settings.combat`, then ''. (Placement is no longer configurable —
 *  combat narration always lands as a new floor; see writeNarrationToChat.) */
export const narrationConfig = (profileId: string, chatId: string): { extra: string } => {
  const chat = getChat(profileId, chatId)
  const card = chat ? getCharacter(profileId, chat.character_id) : null
  const bundle = (card ? getRpExt(card)?.combat : null) as
    | (CombatBundle & { narration_prompt?: string })
    | null
    | undefined
  const sCombat = getSettings(profileId).combat
  const extra = (bundle?.narration_prompt || sCombat?.narrationPrompt || '').trim()
  return { extra }
}

/** Flatten a combat/duel event log to plain lines — the "input" shown on the narration floor. */
export const combatLogText = (log: Array<{ text?: string }> | undefined): string =>
  (log ?? [])
    .map((e) => e?.text)
    .filter(Boolean)
    .join('\n')

/** A system prompt that hands the model the card's OWN MVU `data_schema`, so post-combat
 *  `<UpdateVariable>` consequences match the declared shapes (an object where the schema wants an
 *  object, not a bare string). The narration `generateRaw` is otherwise context-free (no lorebooks or
 *  schema), so the model would guess a format and can emit schema-invalid state (e.g. writing
 *  `状态效果.昏迷` as a string). Generic: forwards the card's own schema, no field-specific engine
 *  knowledge. Returns '' when the card ships no schema. */
export const narrationSchemaPrompt = (profileId: string, chatId: string): string => {
  const chat = getChat(profileId, chatId)
  const card = chat ? getCharacter(profileId, chat.character_id) : null
  const schema = card ? (getRpExt(card)?.data_schema as string | undefined)?.trim() : ''
  if (!schema) return ''
  return [
    "The chat's MVU `stat_data` conforms to the Zod schema below. When you record consequences in an",
    '<UpdateVariable> block, every value MUST match the shape this schema declares — e.g. where a field',
    'is an object, write an object (not a bare string).',
    '',
    '```ts',
    schema,
    '```'
  ].join('\n')
}

/** Land combat/duel prose in the chat as a NEW floor whose user-side content is the fight `log` (the
 *  input that produced the narration) and whose response is the narrated prose — so a resolved fight
 *  reads as its own beat in the transcript rather than being glued onto the pre-combat floor. Any
 *  `<UpdateVariable>` consequences fold into the new floor's `stat_data` (cloned from the latest floor). */
export const writeNarrationToChat = (
  profileId: string,
  chatId: string,
  prose: string,
  log = ''
): void => {
  const chat = getChat(profileId, chatId)
  if (!prose || !chat) return
  const floors = getAllFloors(profileId, chatId)
  const now = new Date().toISOString()
  const variables = clone(floors[floors.length - 1]?.variables ?? {}) as Record<string, any>
  foldNarrationMvu(variables, prose)
  appendFloor(profileId, chatId, {
    floor: floors.length,
    chat_id: chatId,
    timestamp: now,
    user_message: { content: log, timestamp: now },
    response: { content: prose, model: '', provider: '' },
    events: [],
    variables
  })
}
