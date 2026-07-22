// src/main/services/chatWriteService.ts
//
// The chat-WRITE domain (TavernHelper setChatMessages / deleteChatMessages / saveChat), extracted from the
// WCV IPC handlers so BOTH transports — the WCV IPC and the inline window.api — call ONE implementation
// (SP3 parity by construction). Transport-agnostic: takes explicit (profileId, chatId); the caller does its
// own post-mutation refresh (WCV pushes to its panels; the inline renderer reloads its store) via the
// `afterChatMutation` read-back below. Every write here goes through FloorState, which re-folds and
// republishes the affected suffix inside the mutation itself.
import * as floorService from './floorService'
import * as chatService from './chatService'
import { chatIndexMap } from '../../shared/thRuntime/shapes'
import type { FloorFile } from '../types/chat'
import { floorStateForChat, type FloorTranscriptUpdate } from './agentRuntime/floorState'

/**
 * Edit message content by chat-array index (TH setChatMessages). Returns the count of floors actually
 * CHANGED — a message whose text is identical to the current content is skipped entirely (a card
 * re-rendering the same text must not trigger the re-fold/reload chain; see
 * test/cardChatEditFeedbackLoop.test.ts).
 */
export function setChatMessages(profileId: string, chatId: string, messages: unknown): number {
  const floors = floorService.getAllFloors(profileId, chatId)
  const map = chatIndexMap(floors)
  // The opening greeting (first_mes / home-UI placeholder) belongs to floor 0 ONLY. See saveChat.
  const opening = floors[0]?.response.content
  const touched = new Set<number>()
  for (const m of Array.isArray(messages) ? messages : []) {
    const id = typeof (m as any)?.message_id === 'number' ? (m as any).message_id : -1
    const slot = id >= 0 ? map[id] : undefined
    const text = (m as any)?.message
    if (!slot || typeof text !== 'string') continue
    // Never let a card write the opening greeting onto a NON-opening floor's response (twin of the
    // saveChat guard) — a stale card chat echoed back would otherwise clobber a real reply.
    if (!slot.isUser && slot.floorIdx > 0 && opening && text === opening) continue
    const current = slot.isUser
      ? floors[slot.floorIdx].user_message.content
      : floors[slot.floorIdx].response.content
    if (current === text) continue
    if (slot.isUser) floors[slot.floorIdx].user_message.content = text
    else floors[slot.floorIdx].response.content = text
    touched.add(slot.floorIdx)
  }
  // A deleted chat has no session store, so `floorStateForChat` is null and the edit is dropped —
  // exactly what the old fallback did (its `saveFloor` no-ops on the same missing store).
  if (touched.size)
    floorStateForChat(chatId)?.updateTranscript(
      chatId,
      [...touched].map(
        (fi): FloorTranscriptUpdate => ({
          floor: floors[fi].floor,
          userContent: floors[fi].user_message.content,
          responseContent: floors[fi].response.content
        })
      )
    )
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

export interface SaveChatResult {
  ok: boolean
  /** Earliest floor whose content/swipes actually changed; null = a no-op echo (zero writes). */
  changedFrom: number | null
}

/**
 * Persist a chat the card mutated (TH saveChat) — map assistant messages back to floors in order, updating
 * content + swipes/swipe_id. User messages are read-only here.
 *
 * Diff-first (audit P1-4): cards routinely echo the WHOLE `SillyTavern.chat` back unchanged; this used to
 * rewrite every assistant floor and then trigger a full-transcript re-fold. Only floors that actually
 * differ are written, and `changedFrom` lets the caller skip (no-op) or bound (suffix) the reevaluation.
 */
export function saveChat(profileId: string, chatId: string, chat: unknown): SaveChatResult {
  if (!Array.isArray(chat)) return { ok: false, changedFrom: null }
  const floors = floorService.getAllFloors(profileId, chatId)
  // The opening greeting (first_mes / home-UI placeholder) belongs to floor 0 ONLY. Capture it so a
  // STALE `SillyTavern.chat` echoed back here can't clobber a real later response with the placeholder.
  // (Owner report: after a custom-start, the home UI's regex placeholder bled onto floor 1 — a stale
  // card chat, still holding the greeting in the assistant[1] slot, was saved over the real reply.)
  const opening = floors[0]?.response.content
  const assistant = chat.filter((m) => m && !(m as any).is_user)
  let changedFrom: number | null = null
  const updates: FloorTranscriptUpdate[] = []
  assistant.forEach((m: any, i) => {
    const f = floors[i]
    if (!f) return
    // Skip a non-opening floor whose incoming text IS the opening greeting — never propagate it forward.
    if (i > 0 && opening && m.mes === opening) return
    const contentChanged = typeof m.mes === 'string' && m.mes !== f.response.content
    const swipesChanged =
      Array.isArray(m.swipes) && JSON.stringify(m.swipes) !== JSON.stringify(f.swipes)
    const swipeIdChanged = typeof m.swipe_id === 'number' && m.swipe_id !== f.swipe_id
    if (!contentChanged && !swipesChanged && !swipeIdChanged) return
    if (contentChanged) f.response.content = m.mes
    if (swipesChanged) f.swipes = m.swipes
    if (swipeIdChanged) f.swipe_id = m.swipe_id
    updates.push({
      floor: f.floor,
      ...(contentChanged ? { responseContent: f.response.content } : {}),
      ...(swipesChanged ? { swipes: f.swipes } : {}),
      ...(swipeIdChanged ? { swipeId: f.swipe_id } : {})
    })
    if (changedFrom === null || f.floor < changedFrom) changedFrom = f.floor
  })
  if (updates.length) floorStateForChat(chatId)?.updateTranscript(chatId, updates)
  return { ok: true, changedFrom }
}

/**
 * Read back the latest floor after a card mutation, so the caller can push its variables to whatever UI
 * it owns (WCV panels / the renderer store). The re-fold itself already happened INSIDE the mutation:
 * every write above goes through FloorState, which republishes the affected suffix atomically — so
 * there is no replay window to choose here, and no floor argument to take. Callers that still need the
 * earliest changed floor read it from `SaveChatResult.changedFrom` (to skip a no-op echo, and to log).
 */
export function afterChatMutation(profileId: string, chatId: string): FloorFile | null {
  return floorService.getAllFloors(profileId, chatId).at(-1) ?? null
}
