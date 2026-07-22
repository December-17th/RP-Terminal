export * from './FloorState'

import { getSessionDbByChat } from '../../sessionDbService'
import { createFloorState } from './FloorState'

/**
 * Production adapter for the per-chat SQLite seam. Deleted chats deliberately return null.
 *
 * Nothing is injected here: the chat→card combat-mode resolver is registered process-wide on
 * `FloorState` itself (`setCombatModeResolver`, re-exported above and wired in `src/main/index.ts`),
 * so the two construction sites that CANNOT go through this adapter — `floorService`'s deletion path
 * and `InvocationRuntimeService.incorporate`, which needs its own transaction-scoped db — inherit it
 * too. A resolver wired at only one construction point is a half-fix that reads as done.
 */
export const floorStateForChat = (chatId: string): ReturnType<typeof createFloorState> | null => {
  const db = getSessionDbByChat(chatId)
  return db ? createFloorState({ db }) : null
}
