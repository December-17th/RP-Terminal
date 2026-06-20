import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { Lorebook, LorebookEntry, LorebookSchema } from '../types/character'

/**
 * Lorebooks are file-based, id-keyed artifacts: `lorebooks/<id>.json`. A card's
 * embedded lorebook is stored under id == characterId, so a character always has
 * an associated lorebook (and existing per-character files keep working); extra
 * standalone lorebooks get a uuid id. A chat selects which lorebook ids are active.
 */

const lorebooksDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'lorebooks')
const lorebookPath = (profileId: string, id: string): string =>
  path.join(lorebooksDir(profileId), `${id}.json`)
// Pre-Phase-F location (embedded lorebook lived under the character dir).
const legacyLorebookPath = (profileId: string, characterId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'characters', characterId, 'lorebook.json')

export interface LorebookSummary {
  id: string
  name: string
}

/** Every lorebook in this profile's library (id = filename stem; name from content). */
export const listLorebooks = (profileId: string): LorebookSummary[] => {
  const dir = lorebooksDir(profileId)
  const out: LorebookSummary[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const id = file.replace(/\.json$/, '')
    const data = readJsonSync<Lorebook>(path.join(dir, file))
    if (data) out.push({ id, name: data.name || 'Untitled Lorebook' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Read a lorebook by id (falls back to the legacy per-character path on miss). */
export const getLorebookById = (profileId: string, id: string): Lorebook | null => {
  let data = readJsonSync(lorebookPath(profileId, id))
  if (!data) data = readJsonSync(legacyLorebookPath(profileId, id)) // migrate-on-read
  if (!data) return null
  const parsed = LorebookSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export const saveLorebookById = (profileId: string, id: string, lorebook: Lorebook): void => {
  ensureDir(lorebooksDir(profileId))
  writeJsonSyncAtomic(lorebookPath(profileId, id), LorebookSchema.parse(lorebook))
}

export const deleteLorebookById = (profileId: string, id: string): void => {
  const p = lorebookPath(profileId, id)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

/** Create a new, empty standalone lorebook. Returns its id. */
export const createLorebook = (profileId: string, name = 'New Lorebook'): LorebookSummary => {
  const id = randomUUID()
  saveLorebookById(profileId, id, LorebookSchema.parse({ name, entries: [] }))
  return { id, name }
}

// --- Character-bound helpers (id == characterId) — kept for import/delete flows ---
export const getCharacterLorebook = (profileId: string, characterId: string): Lorebook | null =>
  getLorebookById(profileId, characterId)

export const saveCharacterLorebook = (
  profileId: string,
  characterId: string,
  lorebook: Lorebook
): void => saveLorebookById(profileId, characterId, lorebook)

export const deleteCharacterLorebook = (profileId: string, characterId: string): void =>
  deleteLorebookById(profileId, characterId)

/**
 * Select which lorebook entries to inject given the recent conversation text.
 * Constant entries always fire; the rest fire on a keyword match. An entry with
 * probability < 100 then rolls (per turn) to decide whether it actually fires.
 * Returns entries sorted by insertion_order (lower = earlier). Pure aside from the
 * injectable `rng` (defaults to Math.random) — pass a fixed rng to test the roll.
 */
export const matchEntries = (
  lorebook: Lorebook | null,
  scanText: string,
  rng: () => number = Math.random
): LorebookEntry[] => {
  if (!lorebook || lorebook.entries.length === 0) return []
  const matched: LorebookEntry[] = []

  const rollFails = (entry: LorebookEntry): boolean =>
    entry.probability < 100 && rng() * 100 >= entry.probability

  for (const entry of lorebook.entries) {
    if (!entry.enabled) continue
    if (entry.constant) {
      if (!rollFails(entry)) matched.push(entry)
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
    if (rollFails(entry)) continue
    matched.push(entry)
  }

  return matched.sort((a, b) => a.insertion_order - b.insertion_order)
}

/** Match across several active lorebooks at once, merged and ordered together. */
export const matchAcross = (
  lorebooks: Lorebook[],
  scanText: string,
  rng: () => number = Math.random
): LorebookEntry[] =>
  lorebooks
    .flatMap((lb) => matchEntries(lb, scanText, rng))
    .sort((a, b) => a.insertion_order - b.insertion_order)

/**
 * Normalize a raw ST world-info / character_book object into our Lorebook shape.
 * Accepts array-style and object-keyed `entries`, mapping ST field aliases. Returns
 * null if there are no usable entries.
 */
export const normalizeLorebookData = (raw: any, fallbackName: string): Lorebook | null => {
  if (!raw) return null
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries || {})
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return null

  const entries = rawEntries.map((e: any) => ({
    keys: e.keys || e.key || [],
    secondary_keys: e.secondary_keys || e.keysecondary || [],
    content: e.content || '',
    enabled: e.enabled !== false && e.disable !== true,
    insertion_order: e.insertion_order ?? e.order ?? 100,
    // ST world-info position 4 = "at depth"; otherwise our default top placement.
    insertion_depth:
      e.position === 4 ? (typeof e.depth === 'number' ? e.depth : 4) : (e.insertion_depth ?? null),
    case_sensitive: e.case_sensitive === true || e.caseSensitive === true,
    constant: e.constant === true,
    selective: e.selective === true,
    probability: typeof e.probability === 'number' ? e.probability : 100,
    comment: e.comment || e.name || ''
  }))

  return LorebookSchema.parse({ name: raw.name || fallbackName, entries })
}

/** Import an ST world-info / lorebook JSON file as a new standalone lorebook. */
export const importLorebookFromFile = (
  profileId: string,
  filePath: string
): LorebookSummary | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const lb = normalizeLorebookData(raw, path.basename(filePath, '.json'))
    if (!lb) return null
    const id = randomUUID()
    saveLorebookById(profileId, id, lb)
    return { id, name: lb.name }
  } catch {
    return null
  }
}

/** Write a lorebook to a JSON file (our native {name, entries} format). */
export const exportLorebookToFile = (profileId: string, id: string, filePath: string): boolean => {
  const lb = getLorebookById(profileId, id)
  if (!lb) return false
  fs.writeFileSync(filePath, JSON.stringify(lb, null, 2), 'utf-8')
  return true
}
