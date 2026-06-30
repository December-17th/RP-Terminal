// src/main/services/duelPreviewService.ts
//
// Gather the active chat's latest stat_data + the character's combat bundle and compute the
// generic DuelPreview for the card UI's 战斗 tab (the getDuelPreview host API). See
// docs/superpowers/specs/2026-06-30-duel-build-preview-tab-design.md.

import { buildDuelPreview } from '../../shared/combat/systems/poemPreview'
import type { DuelPreview } from '../../shared/combat/deckbuilder/preview'
import type { StatMap, DeriveConfig } from '../../shared/combat/bundle'
import { getCharacter } from './characterService'
import { getRpExt } from '../types/character'
import { getAllFloors } from './floorService'

/** The current floor's MVU `stat_data` (where the party's stats live), or null if none.
 *  Mirrors `currentStatData` in combatService. */
const getLatestStatData = (
  profileId: string,
  chatId: string
): Record<string, unknown> | null => {
  const floors = getAllFloors(profileId, chatId)
  const vars = (floors[floors.length - 1]?.variables ?? {}) as Record<string, unknown>
  const sd = vars.stat_data as Record<string, unknown> | undefined
  return sd ?? null
}

/**
 * Compute the DuelPreview for the card UI's 战斗 tab.
 *
 * Returns null when:
 * - There are no floors / no stat_data for the chat, or
 * - The character has no `combat` extension bundle, or
 * - The bundle has no `stat_map` (needed by the poem mapper).
 *
 * Never throws — missing data is a normal condition (card without combat ext, empty chat).
 */
export function computeDuelPreview(
  profileId: string,
  chatId: string,
  characterId: string
): DuelPreview | null {
  const statData = getLatestStatData(profileId, chatId)
  const character = getCharacter(profileId, characterId)
  const bundle = (character ? getRpExt(character)?.combat : null) as
    | { stat_map?: StatMap; derive?: DeriveConfig }
    | null
    | undefined
  if (!statData || !bundle?.stat_map) return null
  return buildDuelPreview(statData, bundle.stat_map, { derive: bundle.derive })
}
