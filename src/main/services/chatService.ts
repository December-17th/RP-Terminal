import { v4 as uuidv4 } from 'uuid'
import { getDb } from './db'
import { ChatSession, FloorFile } from '../types/chat'
import { getCharacter } from './characterService'
import { saveFloor, deleteFloorAndSubsequent, updateFloorFields } from './floorService'

interface ChatRow {
  id: string
  character_id: string
  created_at: string
  updated_at: string
  floor_count: number
  lorebook_ids: string | null
}

export const parseLorebookIds = (raw: string | null): string[] | null => {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null
  } catch {
    return null
  }
}

const preview = (text: string, len = 80): string =>
  text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, len)

const touch = (chatId: string): void => {
  getDb()
    .prepare('UPDATE chats SET updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), chatId)
}

/** Build the renderer-facing session object: count + a single-entry index of the latest floor. */
const buildSession = (row: ChatRow): ChatSession => {
  const last = getDb()
    .prepare(
      'SELECT floor, timestamp, user_content, response_content FROM floors WHERE chat_id = ? ORDER BY floor DESC LIMIT 1'
    )
    .get(row.id) as
    | { floor: number; timestamp: string; user_content: string; response_content: string }
    | undefined

  return {
    id: row.id,
    character_id: row.character_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    floor_count: row.floor_count,
    lorebook_ids: parseLorebookIds(row.lorebook_ids),
    floor_index: last
      ? [
          {
            floor: last.floor,
            timestamp: last.timestamp,
            user_preview: preview(last.user_content),
            response_preview: preview(last.response_content, 220)
          }
        ]
      : []
  }
}

const COUNT_SQL = '(SELECT COUNT(*) FROM floors f WHERE f.chat_id = chats.id) AS floor_count'

export const getChats = (profileId: string): ChatSession[] => {
  const rows = getDb()
    .prepare(
      `SELECT id, character_id, created_at, updated_at, lorebook_ids, ${COUNT_SQL}
       FROM chats WHERE profile_id = ? ORDER BY updated_at DESC`
    )
    .all(profileId) as ChatRow[]
  return rows.map(buildSession)
}

export const getChat = (profileId: string, chatId: string): ChatSession | null => {
  const row = getDb()
    .prepare(
      `SELECT id, character_id, created_at, updated_at, lorebook_ids, ${COUNT_SQL}
       FROM chats WHERE id = ? AND profile_id = ?`
    )
    .get(chatId, profileId) as ChatRow | undefined
  return row ? buildSession(row) : null
}

/** The active lorebook ids for a session (null = default to the character's own lorebook). */
export const getChatLorebookIds = (profileId: string, chatId: string): string[] | null => {
  const row = getDb()
    .prepare('SELECT lorebook_ids FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { lorebook_ids: string | null } | undefined
  return row ? parseLorebookIds(row.lorebook_ids) : null
}

/** Set the active lorebook ids for a session (pass null to fall back to default). */
export const setChatLorebookIds = (
  profileId: string,
  chatId: string,
  ids: string[] | null
): void => {
  getDb()
    .prepare('UPDATE chats SET lorebook_ids = ? WHERE id = ? AND profile_id = ?')
    .run(ids === null ? null : JSON.stringify(ids), chatId, profileId)
}

/** Strip a lorebook id out of every session's active set (called when it's deleted). */
export const removeLorebookIdFromChats = (profileId: string, lorebookId: string): void => {
  const rows = getDb()
    .prepare('SELECT id, lorebook_ids FROM chats WHERE profile_id = ? AND lorebook_ids IS NOT NULL')
    .all(profileId) as Array<{ id: string; lorebook_ids: string | null }>
  for (const row of rows) {
    const ids = parseLorebookIds(row.lorebook_ids)
    if (ids && ids.includes(lorebookId)) {
      setChatLorebookIds(
        profileId,
        row.id,
        ids.filter((x) => x !== lorebookId)
      )
    }
  }
}

export const createChat = (profileId: string, characterId: string): ChatSession => {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, profileId, characterId, now, now)

  // Seed the opening greeting (first_mes) as floor 0, with no user message.
  const card = getCharacter(profileId, characterId)
  if (card?.data.first_mes) {
    const greeting: FloorFile = {
      floor: 0,
      chat_id: id,
      timestamp: now,
      user_message: { content: '', timestamp: now },
      response: { content: card.data.first_mes, model: '', provider: 'greeting' },
      events: [],
      variables: {}
    }
    appendFloor(profileId, id, greeting)
  }

  return getChat(profileId, id) as ChatSession
}

/** Persist a floor and bump the chat's updated_at. floor_count is derived, not stored. */
export const appendFloor = (profileId: string, chatId: string, floor: FloorFile): void => {
  saveFloor(profileId, chatId, floor)
  touch(chatId)
}

/** Delete floors >= fromFloor (regenerate / edit) and bump updated_at. */
export const truncateFloors = (profileId: string, chatId: string, fromFloor: number): void => {
  deleteFloorAndSubsequent(profileId, chatId, fromFloor)
  touch(chatId)
}

export const deleteChat = (_profileId: string, chatId: string): void => {
  getDb().prepare('DELETE FROM chats WHERE id = ?').run(chatId)
}

/** Edit a floor's user message and/or response text, then bump updated_at. */
export const editFloorContent = (
  profileId: string,
  chatId: string,
  floorIndex: number,
  userContent: string | null,
  responseContent: string | null
): void => {
  updateFloorFields(profileId, chatId, floorIndex, userContent, responseContent)
  touch(chatId)
}
