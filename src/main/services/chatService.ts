import { v4 as uuidv4 } from 'uuid'
import { getDb } from './db'
import { ChatSession, FloorFile } from '../types/chat'
import { getCharacter } from './characterService'
import { saveFloor, deleteFloorAndSubsequent } from './floorService'

interface ChatRow {
  id: string
  character_id: string
  created_at: string
  updated_at: string
  floor_count: number
}

const preview = (text: string, len = 80): string =>
  text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, len)

const touch = (chatId: string): void => {
  getDb().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    chatId
  )
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
      `SELECT id, character_id, created_at, updated_at, ${COUNT_SQL}
       FROM chats WHERE profile_id = ? ORDER BY updated_at DESC`
    )
    .all(profileId) as ChatRow[]
  return rows.map(buildSession)
}

export const getChat = (profileId: string, chatId: string): ChatSession | null => {
  const row = getDb()
    .prepare(
      `SELECT id, character_id, created_at, updated_at, ${COUNT_SQL}
       FROM chats WHERE id = ? AND profile_id = ?`
    )
    .get(chatId, profileId) as ChatRow | undefined
  return row ? buildSession(row) : null
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
