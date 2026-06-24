// src/shared/thRuntime/shapes.ts
import type { FloorLike, ThMessage, StMessage } from './types'

/**
 * Floors → a flat TH message list. message_id = the COMPACT chat-array index (`chatIndexMap`) — the SAME
 * space `setChatMessages`/`deleteChatMessages` and `SillyTavern.chat[]` use, so a `message_id` round-trips
 * get→set to the correct floor. (Previously this numbered an empty user slot at `2i`, diverging from the
 * set/delete path — reconciled by deriving both from `chatIndexMap`.)
 */
export function floorsToThMessages(floors: FloorLike[]): ThMessage[] {
  return chatIndexMap(floors).map((slot, id) => ({
    message_id: id,
    role: slot.isUser ? 'user' : 'assistant',
    message:
      (slot.isUser
        ? floors[slot.floorIdx].user_message?.content
        : floors[slot.floorIdx].response?.content) ?? ''
  }))
}

/** Last chat-array index (the latest assistant message), or 0 when there are no floors. */
export function currentMessageId(floors: FloorLike[]): number {
  const len = chatIndexMap(floors).length
  return len > 0 ? len - 1 : 0
}

/**
 * Floors → the chat-array index space: per floor, the user slot ONLY when it has content (matching
 * SillyTavern's `chat[]`, which has no empty user messages), then the assistant slot. The sequential index
 * IS the `message_id`. This is the ONE canonical mapping — `floorsToThMessages` (getChatMessages),
 * `setChatMessages`/`deleteChatMessages`, and `floorsToStChat` (`chat[]`) all derive from it, so an id
 * round-trips get→set to the correct floor.
 */
export function chatIndexMap(floors: FloorLike[]): Array<{ floorIdx: number; isUser: boolean }> {
  const out: Array<{ floorIdx: number; isUser: boolean }> = []
  floors.forEach((f, i) => {
    if (f.user_message?.content) out.push({ floorIdx: i, isUser: true })
    out.push({ floorIdx: i, isUser: false })
  })
  return out
}

/** Floors → the SillyTavern `chat[]` shape (each turn = a user + an assistant message). */
export function floorsToStChat(
  floors: FloorLike[],
  names: { charName: string; userName: string; greetings?: string[] }
): StMessage[] {
  const out: StMessage[] = []
  floors.forEach((f, i) => {
    if (f.user_message?.content) {
      out.push({
        is_user: true,
        name: names.userName,
        mes: f.user_message.content,
        send_date: '',
        swipes: [f.user_message.content],
        swipe_id: 0,
        extra: {}
      })
    }
    const swipes =
      i === 0 && names.greetings && names.greetings.length
        ? names.greetings
        : f.swipes && f.swipes.length
          ? f.swipes
          : [f.response?.content ?? '']
    out.push({
      is_user: false,
      name: names.charName,
      mes: f.response?.content ?? '',
      send_date: '',
      swipes,
      swipe_id: f.swipe_id ?? 0,
      extra: {}
    })
  })
  return out
}
