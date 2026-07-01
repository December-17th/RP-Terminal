import { getDb } from './db'

/** JSON-encode a node-state value for the data column. undefined → null (cleared). */
export const encodeNodeState = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value)

/** Decode a stored data column; null/corrupt rows read as undefined (state never throws). */
export const decodeNodeState = (data: string | null | undefined): unknown => {
  if (data == null) return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

/** Read a node's durable per-chat state (workflow spec §11). */
export const getNodeState = (chatId: string, nodeId: string): unknown => {
  const row = getDb()
    .prepare('SELECT data FROM node_state WHERE chat_id = ? AND node_id = ?')
    .get(chatId, nodeId) as { data: string | null } | undefined
  return decodeNodeState(row?.data)
}

/** Write (or clear, with undefined) a node's durable per-chat state. */
export const setNodeState = (chatId: string, nodeId: string, value: unknown): void => {
  if (value === undefined) {
    getDb().prepare('DELETE FROM node_state WHERE chat_id = ? AND node_id = ?').run(chatId, nodeId)
    return
  }
  getDb()
    .prepare(
      `INSERT INTO node_state (chat_id, node_id, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, node_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    )
    .run(chatId, nodeId, encodeNodeState(value), new Date().toISOString())
}
