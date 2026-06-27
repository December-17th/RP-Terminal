// src/main/services/chatWriteService.ts
//
// The chat-WRITE domain (TavernHelper setChatMessages / deleteChatMessages / saveChat), extracted from the
// WCV IPC handlers so BOTH transports — the WCV IPC and the inline window.api — call ONE implementation
// (SP3 parity by construction). Transport-agnostic: takes explicit (profileId, chatId); the caller does its
// own post-mutation refresh (WCV pushes to its panels; the inline renderer reloads its store) via the
// `afterChatMutation` re-fold below.
import * as floorService from './floorService'
import * as chatService from './chatService'
import * as generationService from './generationService'
import { chatIndexMap } from '../../shared/thRuntime/shapes'
import type { FloorFile } from '../types/chat'

/** Edit message content by chat-array index (TH setChatMessages). Returns the count of floors touched. */
export function setChatMessages(profileId: string, chatId: string, messages: unknown): number {
  const floors = floorService.getAllFloors(profileId, chatId)
  const map = chatIndexMap(floors)
  const touched = new Set<number>()
  for (const m of Array.isArray(messages) ? messages : []) {
    const id = typeof (m as any)?.message_id === 'number' ? (m as any).message_id : -1
    const slot = id >= 0 ? map[id] : undefined
    const text = (m as any)?.message
    if (!slot || typeof text !== 'string') continue
    if (slot.isUser) floors[slot.floorIdx].user_message.content = text
    else floors[slot.floorIdx].response.content = text
    touched.add(slot.floorIdx)
  }
  for (const fi of touched) floorService.saveFloor(profileId, chatId, floors[fi])
  return touched.size
}

/**
 * Delete messages (TH deleteChatMessages). The floor model couples user+assistant, so this TRUNCATES from
 * the earliest targeted message's floor onward (the common "delete from here / undo").
 */
export function deleteChatMessages(
  profileId: string,
  chatId: string,
  messageIds: unknown
): boolean {
  const floors = floorService.getAllFloors(profileId, chatId)
  const map = chatIndexMap(floors)
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(
    (n): n is number => typeof n === 'number'
  )
  const floorIdxs = ids
    .map((id) => map[id]?.floorIdx)
    .filter((n): n is number => typeof n === 'number')
  if (!floorIdxs.length) return false
  const fromFloor = floors[Math.min(...floorIdxs)]?.floor
  if (typeof fromFloor !== 'number') return false
  chatService.truncateFloors(profileId, chatId, fromFloor)
  return true
}

/**
 * Persist a chat the card mutated (TH saveChat) — map assistant messages back to floors in order, updating
 * content + swipes/swipe_id. User messages are read-only here.
 */
export function saveChat(profileId: string, chatId: string, chat: unknown): boolean {
  if (!Array.isArray(chat)) return false
  const floors = floorService.getAllFloors(profileId, chatId)
  const assistant = chat.filter((m) => m && !(m as any).is_user)
  assistant.forEach((m: any, i) => {
    const f = floors[i]
    if (!f) return
    if (typeof m.mes === 'string') f.response.content = m.mes
    if (Array.isArray(m.swipes)) f.swipes = m.swipes
    if (typeof m.swipe_id === 'number') f.swipe_id = m.swipe_id
    floorService.saveFloor(profileId, chatId, f)
  })
  return true
}

/**
 * Re-fold the model's `<UpdateVariable>` into stat_data after a card mutation (same engine as the
 * Re-evaluate button). Returns the rebuilt latest floor so the caller can push its variables to whatever
 * UI it owns (WCV panels / the renderer store).
 */
export function afterChatMutation(profileId: string, chatId: string): FloorFile | null {
  const rebuilt = generationService.reevaluateVariables(profileId, chatId)
  return rebuilt[rebuilt.length - 1] ?? null
}
