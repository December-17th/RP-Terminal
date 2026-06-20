import fs from 'fs'
import path from 'path'
import { getAppDir, ensureDir, readJsonSync, writeJsonSyncAtomic } from './storageService'
import { Lorebook, LorebookEntry, LorebookSchema } from '../types/character'

const lorebooksDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'lorebooks')
const lorebookPath = (profileId: string, characterId: string): string =>
  path.join(lorebooksDir(profileId), `${characterId}.json`)
// Pre-Phase-F location (embedded lorebook lived under the character dir).
const legacyLorebookPath = (profileId: string, characterId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'characters', characterId, 'lorebook.json')

export const getCharacterLorebook = (profileId: string, characterId: string): Lorebook | null => {
  let data = readJsonSync(lorebookPath(profileId, characterId))
  if (!data) data = readJsonSync(legacyLorebookPath(profileId, characterId)) // migrate-on-read
  if (!data) return null
  const parsed = LorebookSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export const saveCharacterLorebook = (
  profileId: string,
  characterId: string,
  lorebook: Lorebook
): void => {
  ensureDir(lorebooksDir(profileId))
  writeJsonSyncAtomic(lorebookPath(profileId, characterId), LorebookSchema.parse(lorebook))
}

export const deleteCharacterLorebook = (profileId: string, characterId: string): void => {
  const p = lorebookPath(profileId, characterId)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

/**
 * Select which lorebook entries to inject given the recent conversation text.
 * Constant entries always fire; the rest fire on a keyword match. Returns entries
 * sorted by insertion_order (lower = earlier). Pure function — no IO.
 */
export const matchEntries = (lorebook: Lorebook | null, scanText: string): LorebookEntry[] => {
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
