import { getSessionDbByChat } from './sessionDbService'

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

/** Read a node's durable per-(chat, workflow) state (workflow spec §11). */
export const getNodeState = (chatId: string, workflowId: string, nodeId: string): unknown => {
  const db = getSessionDbByChat(chatId)
  if (!db) return undefined
  const row = db
    .prepare('SELECT data FROM node_state WHERE chat_id = ? AND workflow_id = ? AND node_id = ?')
    .get(chatId, workflowId, nodeId) as { data: string | null } | undefined
  return decodeNodeState(row?.data)
}

/** Write (or clear, with undefined) a node's durable per-(chat, workflow) state. */
export const setNodeState = (
  chatId: string,
  workflowId: string,
  nodeId: string,
  value: unknown
): void => {
  const db = getSessionDbByChat(chatId)
  if (!db) return
  if (value === undefined) {
    db.prepare('DELETE FROM node_state WHERE chat_id = ? AND workflow_id = ? AND node_id = ?').run(
      chatId,
      workflowId,
      nodeId
    )
    return
  }
  db.prepare(
    `INSERT INTO node_state (chat_id, workflow_id, node_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, workflow_id, node_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(chatId, workflowId, nodeId, encodeNodeState(value), new Date().toISOString())
}
