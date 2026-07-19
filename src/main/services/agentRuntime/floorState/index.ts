export * from './FloorState'

import { getSessionDbByChat } from '../../sessionDbService'
import { createFloorState } from './FloorState'

/** Production adapter for the per-chat SQLite seam. Deleted chats deliberately return null. */
export const floorStateForChat = (chatId: string): ReturnType<typeof createFloorState> | null => {
  const db = getSessionDbByChat(chatId)
  return db ? createFloorState({ db }) : null
}
