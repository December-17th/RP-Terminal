// src/shared/thRuntime/shapes.ts
import type { FloorLike, ThMessage, StMessage } from './types'

/** Floors → a flat TH message list with sequential ids (floor i → user 2i, assistant 2i+1). */
export function floorsToThMessages(floors: FloorLike[]): ThMessage[] {
  const out: ThMessage[] = []
  floors.forEach((f, i) => {
    out.push({ message_id: i * 2, role: 'user', message: f.user_message?.content ?? '' })
    out.push({ message_id: i * 2 + 1, role: 'assistant', message: f.response?.content ?? '' })
  })
  return out
}

/** Last flat message index (2n-1), or 0 when there are no floors. */
export function currentMessageId(floors: FloorLike[]): number {
  const n = floors.length
  return n > 0 ? n * 2 - 1 : 0
}

/**
 * Floors → the COMPACT chat-array index space `setChatMessages`/`deleteChatMessages` use: per floor, the
 * user slot ONLY when it has content, then the assistant slot. This matches `floorsToStChat` (SillyTavern's
 * `chat[]`, which also skips empty user messages).
 *
 * KNOWN DIVERGENCE (preserved, not introduced here): `floorsToThMessages` (`getChatMessages`) instead emits
 * a user message at `2i` even when empty, so a `message_id` read from `getChatMessages` does NOT line up
 * with this map once a floor has an empty user message (floor 0's greeting). Moved verbatim from `wcvIpc`
 * to keep both transports identical; reconciling the get/set id spaces is a separate, deliberate fix.
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
