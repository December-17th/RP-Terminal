// Shared post-combat narration plumbing (grid combat + STS duel). Extracted from combatService so
// both native combat modes narrate + fold MVU consequences identically ("one surface"). Text/prompt
// builders live in shared/combat (pure); THIS module does the model-agnostic chat write + MVU fold.

import { appendFloor, getChat } from './chatService'
import { getAllFloors, saveFloor } from './floorService'
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

/** Resolve the narration prompt + placement, honoring (in order) the card's `combat` bundle
 *  (`narration_prompt` / `narration_mode`), the user's `settings.combat`, then the defaults. */
export const narrationConfig = (
  profileId: string,
  chatId: string
): { extra: string; mode: 'append' | 'floor' } => {
  const chat = getChat(profileId, chatId)
  const card = chat ? getCharacter(profileId, chat.character_id) : null
  const bundle = (card ? getRpExt(card)?.combat : null) as
    | (CombatBundle & { narration_prompt?: string; narration_mode?: string })
    | null
    | undefined
  const sCombat = getSettings(profileId).combat
  const extra = (bundle?.narration_prompt || sCombat?.narrationPrompt || '').trim()
  const mode: 'append' | 'floor' =
    (bundle?.narration_mode || sCombat?.narrationMode) === 'floor' ? 'floor' : 'append'
  return { extra, mode }
}

/** Land combat/duel prose in the chat — appended to the current floor or as a new floor (the
 *  user/card placement setting) — folding any `<UpdateVariable>` consequences into that floor's
 *  stat_data. */
export const writeNarrationToChat = (profileId: string, chatId: string, prose: string): void => {
  const chat = getChat(profileId, chatId)
  if (!prose || !chat) return
  const { mode } = narrationConfig(profileId, chatId)
  const floors = getAllFloors(profileId, chatId)
  const now = new Date().toISOString()
  if (mode === 'floor' || !floors.length) {
    const variables = clone(floors[floors.length - 1]?.variables ?? {}) as Record<string, any>
    foldNarrationMvu(variables, prose)
    appendFloor(profileId, chatId, {
      floor: floors.length,
      chat_id: chatId,
      timestamp: now,
      user_message: { content: '', timestamp: now },
      response: { content: prose, model: '', provider: '' },
      events: [],
      variables
    })
  } else {
    const last = floors[floors.length - 1]
    last.response = { ...last.response, content: `${last.response.content}\n\n${prose}`.trim() }
    const variables = (last.variables ?? {}) as Record<string, any>
    foldNarrationMvu(variables, prose)
    last.variables = variables
    saveFloor(profileId, chatId, last)
  }
}
