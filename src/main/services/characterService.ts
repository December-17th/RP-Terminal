import fs from 'fs'
import path from 'path'
import { getAppDir, ensureDir, writeJsonSyncAtomic, readJsonSync, listDirectoriesSync } from './storageService'
import {
  RPTerminalCard,
  RPTerminalCardSchema,
  Lorebook,
  LorebookSchema
} from '../types/character'
import { saveCharacterLorebook } from './lorebookService'
import { parseStPng } from '../parsers/stPngParser'

export const getCharactersDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'characters')

export const getCharacters = (profileId: string): Array<{ id: string; card: RPTerminalCard }> => {
  const charsDir = getCharactersDir(profileId)
  if (!fs.existsSync(charsDir)) return []

  const characters: Array<{ id: string; card: RPTerminalCard }> = []
  for (const id of listDirectoriesSync(charsDir)) {
    const raw = readJsonSync(path.join(charsDir, id, 'card.json'))
    if (!raw) continue
    const parsed = RPTerminalCardSchema.safeParse(raw)
    if (parsed.success) {
      characters.push({ id, card: parsed.data })
    } else {
      console.warn(`Skipping invalid card ${id}:`, parsed.error.issues?.[0]?.message)
    }
  }
  return characters
}

export const getCharacter = (profileId: string, characterId: string): RPTerminalCard | null => {
  const raw = readJsonSync(path.join(getCharactersDir(profileId), characterId, 'card.json'))
  if (!raw) return null
  const parsed = RPTerminalCardSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export const saveCharacter = (
  profileId: string,
  characterId: string,
  card: RPTerminalCard
): void => {
  // Validate (and fill defaults) before persisting so storage is always canonical.
  const parsed = RPTerminalCardSchema.parse(card)
  const charDir = path.join(getCharactersDir(profileId), characterId)
  ensureDir(charDir)
  writeJsonSyncAtomic(path.join(charDir, 'card.json'), parsed)
}

/**
 * Normalize an embedded ST `character_book` (array-of-entries with `keys`) or a
 * standalone world-info object (`entries` keyed by id with `key`) into our
 * Lorebook shape. Returns null if there's nothing usable.
 */
const normalizeLorebook = (raw: any, fallbackName: string): Lorebook | null => {
  if (!raw) return null

  const rawEntries = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries || {})
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return null

  const entries = rawEntries.map((e: any) => ({
    keys: e.keys || e.key || [],
    secondary_keys: e.secondary_keys || e.keysecondary || [],
    content: e.content || '',
    enabled: e.enabled !== false && e.disable !== true,
    insertion_order: e.insertion_order ?? e.order ?? 100,
    case_sensitive: e.case_sensitive === true || e.caseSensitive === true,
    constant: e.constant === true,
    selective: e.selective === true,
    comment: e.comment || e.name || ''
  }))

  return LorebookSchema.parse({ name: raw.name || fallbackName, entries })
}

/**
 * Import an ST character card (PNG with embedded JSON, or raw JSON) and convert
 * it to a canonical RPTerminalCard. Handles v1 (flat), v2 and v3 (data-wrapped)
 * specs, extracts an embedded lorebook, and preserves an existing rp_terminal
 * extension block if the card already has one.
 */
export const importCharacterFromFile = (profileId: string, filePath: string): string | null => {
  try {
    const ext = path.extname(filePath).toLowerCase()
    let stData: any = null

    if (ext === '.png') {
      stData = parseStPng(filePath)
    } else if (ext === '.json') {
      stData = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
    if (!stData) return null

    // v2/v3 wrap fields under `data`; v1 is flat.
    const isWrapped = stData.spec === 'chara_card_v2' || stData.spec === 'chara_card_v3'
    const src = isWrapped ? stData.data : stData

    const existingRpExt = src.extensions?.rp_terminal

    const card: RPTerminalCard = RPTerminalCardSchema.parse({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: src.name || 'Unknown',
        description: src.description || '',
        personality: src.personality || '',
        scenario: src.scenario || '',
        first_mes: src.first_mes || '',
        mes_example: src.mes_example || '',
        creator_notes: src.creator_notes || '',
        system_prompt: src.system_prompt || '',
        post_history_instructions: src.post_history_instructions || '',
        alternate_greetings: src.alternate_greetings || [],
        tags: src.tags || [],
        creator: src.creator || '',
        character_version: src.character_version || '',
        extensions: existingRpExt ? { rp_terminal: existingRpExt } : {}
      }
    })

    const newId = crypto.randomUUID()
    saveCharacter(profileId, newId, card)

    // Extract an embedded lorebook (v3 `character_book`, or `data.character_book`).
    const lorebook = normalizeLorebook(
      src.character_book || stData.character_book,
      card.data.name
    )
    if (lorebook) {
      saveCharacterLorebook(profileId, newId, lorebook)
    }

    // Copy the source PNG as the avatar.
    if (ext === '.png') {
      fs.copyFileSync(filePath, path.join(getCharactersDir(profileId), newId, 'avatar.png'))
    }

    return newId
  } catch (error) {
    console.error('Failed to import character:', error)
    return null
  }
}
