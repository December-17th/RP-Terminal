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

/** Floors → the SillyTavern `chat[]` shape (each turn = a user + an assistant message). */
export function floorsToStChat(
  floors: FloorLike[],
  names: { charName: string; userName: string }
): StMessage[] {
  const out: StMessage[] = []
  for (const f of floors) {
    out.push({
      is_user: true,
      name: names.userName,
      mes: f.user_message?.content ?? '',
      send_date: '',
      swipes: [],
      swipe_id: 0,
      extra: {}
    })
    out.push({
      is_user: false,
      name: names.charName,
      mes: f.response?.content ?? '',
      send_date: '',
      swipes: f.swipes ?? [f.response?.content ?? ''],
      swipe_id: f.swipe_id ?? 0,
      extra: {}
    })
  }
  return out
}
