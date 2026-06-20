import path from 'path'
import { getCharactersDir } from './characterService'
import { writeJsonSyncAtomic, readJsonSync } from './storageService'
import { Lorebook, LorebookEntry, LorebookSchema } from '../types/character'

const getLorebookPath = (profileId: string, characterId: string) =>
  path.join(getCharactersDir(profileId), characterId, 'lorebook.json')

export const saveCharacterLorebook = (
  profileId: string,
  characterId: string,
  lorebook: Lorebook
): void => {
  // Validate + fill defaults so edits from the renderer are always canonical.
  writeJsonSyncAtomic(getLorebookPath(profileId, characterId), LorebookSchema.parse(lorebook))
}

export const getCharacterLorebook = (
  profileId: string,
  characterId: string
): Lorebook | null => {
  return readJsonSync<Lorebook>(getLorebookPath(profileId, characterId))
}

/**
 * Select which lorebook entries to inject given the recent conversation text.
 * Constant entries always fire; the rest fire when one of their keys appears in
 * the scan text. Returns entries sorted by insertion_order (lower = earlier).
 */
export const matchEntries = (
  lorebook: Lorebook | null,
  scanText: string
): LorebookEntry[] => {
  if (!lorebook || lorebook.entries.length === 0) return []

  const matched: LorebookEntry[] = []

  for (const entry of lorebook.entries) {
    if (!entry.enabled) continue

    if (entry.constant) {
      matched.push(entry)
      continue
    }

    const haystack = entry.case_sensitive ? scanText : scanText.toLowerCase()
    const keyHit = entry.keys.some((k) => {
      if (!k) return false
      const needle = entry.case_sensitive ? k : k.toLowerCase()
      return haystack.includes(needle)
    })
    if (!keyHit) continue

    // Selective entries also require a secondary key match.
    if (entry.selective && entry.secondary_keys.length > 0) {
      const secHit = entry.secondary_keys.some((k) => {
        if (!k) return false
        const needle = entry.case_sensitive ? k : k.toLowerCase()
        return haystack.includes(needle)
      })
      if (!secHit) continue
    }

    matched.push(entry)
  }

  return matched.sort((a, b) => a.insertion_order - b.insertion_order)
}
