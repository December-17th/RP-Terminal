import { getDb } from './db'
import { FloorFile } from '../types/chat'

interface FloorRow {
  floor: number
  chat_id: string
  timestamp: string
  user_content: string
  user_timestamp: string | null
  response_content: string
  response_model: string | null
  response_provider: string | null
  events: string
  variables: string
}

const rowToFloor = (r: FloorRow): FloorFile => ({
  floor: r.floor,
  chat_id: r.chat_id,
  timestamp: r.timestamp,
  user_message: { content: r.user_content, timestamp: r.user_timestamp || r.timestamp },
  response: {
    content: r.response_content,
    model: r.response_model || '',
    provider: r.response_provider || ''
  },
  events: safeJson(r.events, []),
  variables: safeJson(r.variables, {})
})

export const getFloor = (
  _profileId: string,
  chatId: string,
  floorIndex: number
): FloorFile | null => {
  const row = getDb()
    .prepare('SELECT * FROM floors WHERE chat_id = ? AND floor = ?')
    .get(chatId, floorIndex) as FloorRow | undefined
  return row ? rowToFloor(row) : null
}

export const getAllFloors = (_profileId: string, chatId: string, _count?: number): FloorFile[] => {
  const rows = getDb()
    .prepare('SELECT * FROM floors WHERE chat_id = ? ORDER BY floor')
    .all(chatId) as FloorRow[]
  return rows.map(rowToFloor)
}

export const saveFloor = (_profileId: string, chatId: string, floor: FloorFile): void => {
  getDb()
    .prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, user_timestamp, response_content,
         response_model, response_provider, events, variables)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, floor) DO UPDATE SET
         timestamp = excluded.timestamp,
         user_content = excluded.user_content,
         user_timestamp = excluded.user_timestamp,
         response_content = excluded.response_content,
         response_model = excluded.response_model,
         response_provider = excluded.response_provider,
         events = excluded.events,
         variables = excluded.variables`
    )
    .run(
      chatId,
      floor.floor,
      floor.timestamp || new Date().toISOString(),
      floor.user_message?.content ?? '',
      floor.user_message?.timestamp ?? null,
      floor.response?.content ?? '',
      floor.response?.model ?? null,
      floor.response?.provider ?? null,
      JSON.stringify(floor.events ?? []),
      JSON.stringify(floor.variables ?? {})
    )
}

/** Edit a stored floor's text in place (user message and/or AI response). */
export const updateFloorFields = (
  _profileId: string,
  chatId: string,
  floorIndex: number,
  userContent: string | null,
  responseContent: string | null
): void => {
  const db = getDb()
  if (userContent !== null) {
    db.prepare('UPDATE floors SET user_content = ? WHERE chat_id = ? AND floor = ?').run(
      userContent,
      chatId,
      floorIndex
    )
  }
  if (responseContent !== null) {
    db.prepare('UPDATE floors SET response_content = ? WHERE chat_id = ? AND floor = ?').run(
      responseContent,
      chatId,
      floorIndex
    )
  }
}

export const deleteFloorAndSubsequent = (
  _profileId: string,
  chatId: string,
  fromFloorIndex: number
): void => {
  getDb().prepare('DELETE FROM floors WHERE chat_id = ? AND floor >= ?').run(chatId, fromFloorIndex)
}

const safeJson = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
