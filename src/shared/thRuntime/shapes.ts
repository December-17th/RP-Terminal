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
 * Index of the LAST message in the chat being assembled for a turn — matching SillyTavern's `lastMessageId`
 * (= `chat.length - 1`). `hasUserAction` accounts for the pending user input that's appended but not yet a
 * floor: with it, the opening turn (just a greeting) → 1, the value the 命定之诗-style "is this the opening?"
 * checks (`lastMessageId === 1`) rely on; without it (regenerate/continue) → the latest assistant index.
 */
export function lastMessageIndex(floors: FloorLike[], hasUserAction: boolean): number {
  return Math.max(0, chatIndexMap(floors).length - (hasUserAction ? 0 : 1))
}

/** Index of the last USER message in the assembled chat (the pending user action sits at the end). -1 = none. */
export function lastUserMessageIndex(floors: FloorLike[], hasUserAction: boolean): number {
  const map = chatIndexMap(floors)
  if (hasUserAction) return map.length
  for (let i = map.length - 1; i >= 0; i--) if (map[i].isUser) return i
  return -1
}

/** Index of the last ASSISTANT message in the assembled chat. -1 = none. */
export function lastCharMessageIndex(floors: FloorLike[]): number {
  const map = chatIndexMap(floors)
  for (let i = map.length - 1; i >= 0; i--) if (!map[i].isUser) return i
  return -1
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

/**
 * Panel chat-scope messages → synthetic floors the chat-derivation readers (`floorsToStChat`,
 * `floorsToThMessages`) consume. Pairs a `user`→`assistant` sequence into ONE floor: a `user` message
 * opens a floor (its `user_message.content`); the next `assistant` message sets that floor's
 * `response.content` and closes it. A lone assistant (no preceding open user) → a greeting-shaped
 * `{ response }` floor; consecutive users each close as their own `{ user_message }` floor; a trailing
 * unpaired user closes as its own floor. Only the fields those readers read are emitted.
 */
export function messagesToFloors(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): FloorLike[] {
  const out: FloorLike[] = []
  let open: FloorLike | null = null // a floor with a user_message still awaiting its assistant response
  for (const m of messages || []) {
    if (m.role === 'user') {
      if (open) out.push(open) // an earlier unpaired user closes as its own floor
      open = { user_message: { content: m.content } }
    } else {
      if (open) {
        open.response = { content: m.content }
        out.push(open)
        open = null
      } else {
        out.push({ response: { content: m.content } })
      }
    }
  }
  if (open) out.push(open)
  return out
}

/**
 * The MVU message-scope keys inside a floor's `variables` bag. They are the DEFAULT `getVariables()`
 * scope (`{ stat_data }`), not the local/chat scope, so `floorLocalVars` keeps them out of what a card
 * reads as `type:'chat'`. (`combat_cue` is also fold-owned — see `generation/assemble.ts` — but it is a
 * card-readable native surface, so it stays visible; only MVU's own two are message-scope.)
 */
const MVU_MESSAGE_SCOPE_KEYS = ['stat_data', 'delta_data'] as const

/**
 * A floor's `variables` bag → the "local variable" bag, i.e. everything ST-Prompt-Template's
 * `setvar`/`setLocalVar` writes at build time (`templateEngine.ts` `storeFor()` routes every non-global
 * scope to the floor vars), MINUS the MVU message-scope keys above.
 *
 * Upstream this bag IS the chat-scope bag: SillyTavern keeps local variables in
 * `chat_metadata.variables` (`public/scripts/variables.js`), which is exactly what TavernHelper's
 * `getVariables({type:'chat'})` reads. RP Terminal stores them separately (floor variables vs. the
 * per-chat card KV), so BOTH transports funnel their `getFloorVars` through this ONE pure helper —
 * otherwise a lorebook `setLocalVar('char_info_visuals', …)` would be invisible to a card that reads
 * `type:'chat'`, and inline/WCV could omit different keys.
 */
export function floorLocalVars(variables: unknown): Record<string, any> {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return {}
  const out: Record<string, any> = { ...(variables as Record<string, any>) }
  for (const k of MVU_MESSAGE_SCOPE_KEYS) delete out[k]
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
