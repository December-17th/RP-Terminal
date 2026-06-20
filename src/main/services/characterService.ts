import fs from 'fs'
import path from 'path'
import { getAppDir, ensureDir } from './storageService'
import { getDb } from './db'
import { RPTerminalCard, RPTerminalCardSchema } from '../types/character'
import {
  saveCharacterLorebook,
  deleteCharacterLorebook,
  normalizeLorebookData
} from './lorebookService'
import { parseStPng } from '../parsers/stPngParser'

const getAvatarsDir = (): string => path.join(getAppDir(), 'avatars')
export const getAvatarPath = (characterId: string): string =>
  path.join(getAvatarsDir(), `${characterId}.png`)

export const getCharacters = (profileId: string): Array<{ id: string; card: RPTerminalCard }> => {
  const rows = getDb()
    .prepare('SELECT id, card FROM characters WHERE profile_id = ? ORDER BY created_at')
    .all(profileId) as Array<{ id: string; card: string }>

  const out: Array<{ id: string; card: RPTerminalCard }> = []
  for (const row of rows) {
    const parsed = RPTerminalCardSchema.safeParse(safeJson(row.card))
    if (parsed.success) out.push({ id: row.id, card: parsed.data })
    else console.warn(`Skipping invalid card ${row.id}:`, parsed.error.issues?.[0]?.message)
  }
  return out
}

export const getCharacter = (profileId: string, characterId: string): RPTerminalCard | null => {
  const row = getDb()
    .prepare('SELECT card FROM characters WHERE id = ? AND profile_id = ?')
    .get(characterId, profileId) as { card: string } | undefined
  if (!row) return null
  const parsed = RPTerminalCardSchema.safeParse(safeJson(row.card))
  return parsed.success ? parsed.data : null
}

export const saveCharacter = (
  profileId: string,
  characterId: string,
  card: RPTerminalCard
): void => {
  const parsed = RPTerminalCardSchema.parse(card)
  getDb()
    .prepare(
      `INSERT INTO characters (id, profile_id, card, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET card = excluded.card`
    )
    .run(characterId, profileId, JSON.stringify(parsed), new Date().toISOString())
}

export const deleteCharacter = (profileId: string, characterId: string): void => {
  getDb()
    .prepare('DELETE FROM characters WHERE id = ? AND profile_id = ?')
    .run(characterId, profileId)
  deleteCharacterLorebook(profileId, characterId)
  const avatar = getAvatarPath(characterId)
  if (fs.existsSync(avatar)) fs.unlinkSync(avatar)
}

export const importCharacterFromFile = (profileId: string, filePath: string): string | null => {
  try {
    const ext = path.extname(filePath).toLowerCase()
    let stData: any = null

    if (ext === '.png') stData = parseStPng(filePath)
    else if (ext === '.json') stData = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    if (!stData) return null

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

    const lorebook = normalizeLorebookData(src.character_book || stData.character_book, card.data.name)
    if (lorebook) saveCharacterLorebook(profileId, newId, lorebook)

    if (ext === '.png') {
      ensureDir(getAvatarsDir())
      fs.copyFileSync(filePath, getAvatarPath(newId))
    }

    return newId
  } catch (error) {
    console.error('Failed to import character:', error)
    return null
  }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
