/**
 * Canonical SillyTavern / Tavern-Helper event names (TH-1), clean-room.
 *
 * Scripts subscribe with `eventOn(tavern_events.X, cb)`; the host emits these exact
 * string values so the listeners fire. The values mirror ST's `event_types`
 * (snake_case) so scripts that pass raw string literals also match the common cases.
 * We additionally keep emitting the legacy `rpt.v1` lifecycle names
 * (`generation:start/end`, `chat:changed`) for our own documented API — both are sent.
 *
 * No js-slash-runner code is used; this is the public API surface reimplemented.
 */
export const TAVERN_EVENTS = {
  GENERATION_STARTED: 'generation_started',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_STOPPED: 'generation_stopped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_SWIPED: 'message_swiped',
  CHAT_CHANGED: 'chat_changed',
  STREAM_TOKEN_RECEIVED: 'stream_token_received'
} as const

export type TavernEventName = (typeof TAVERN_EVENTS)[keyof typeof TAVERN_EVENTS]

/** The enum as a JS object literal, injected into the sandbox shim (single source of truth). */
export const TAVERN_EVENTS_LITERAL = JSON.stringify(TAVERN_EVENTS)

export interface RuntimeEvent {
  name: string
  payload: unknown
}

interface ChatLifecycle {
  isGenerating: boolean
  floorCount: number
}

/**
 * Map a chat-store transition to the events to dispatch into script iframes. Pure so it
 * can be unit-tested apart from the React hosts (CardScriptHost / PluginHost) that call it.
 * Emits BOTH the legacy `rpt.v1` lifecycle names and the canonical `tavern_events` names:
 *  - generation toggled  → `generation:start`/`end` + GENERATION_STARTED/ENDED
 *  - floor count changed → `chat:changed`
 *  - a new floor landed  → MESSAGE_RECEIVED (payload = the new floor's index)
 * (MESSAGE_SENT/UPDATED/DELETED/SWIPED are emitted at their mutation points in TH-2.)
 */
export const chatTransitionEvents = (prev: ChatLifecycle, next: ChatLifecycle): RuntimeEvent[] => {
  const out: RuntimeEvent[] = []
  if (next.isGenerating !== prev.isGenerating) {
    if (next.isGenerating) {
      out.push({ name: 'generation:start', payload: {} })
      out.push({ name: TAVERN_EVENTS.GENERATION_STARTED, payload: {} })
    } else {
      out.push({ name: 'generation:end', payload: {} })
      out.push({ name: TAVERN_EVENTS.GENERATION_ENDED, payload: {} })
    }
  }
  if (next.floorCount !== prev.floorCount) {
    out.push({ name: 'chat:changed', payload: { floors: next.floorCount } })
  }
  if (next.floorCount > prev.floorCount) {
    out.push({ name: TAVERN_EVENTS.MESSAGE_RECEIVED, payload: next.floorCount - 1 })
  }
  return out
}

/** A floor reduced to what message-mutation diffing needs (TH-2). */
export interface FloorDescriptor {
  floor: number
  content: string
  swipeId: number
}

/**
 * Diff two floor snapshots into per-message mutation events (TH-2), so scripts react to
 * edits/swipes/deletes done in the UI or via the script API:
 *  - a floor present before but gone after → MESSAGE_DELETED
 *  - same floor, active swipe changed      → MESSAGE_SWIPED
 *  - same floor, response text changed     → MESSAGE_UPDATED
 * New floors are already signalled by MESSAGE_RECEIVED (chatTransitionEvents). Pure +
 * unit-tested; the hosts call it from their chat-store subscription. Payload = floor index.
 */
export const messageMutationEvents = (
  prev: FloorDescriptor[],
  next: FloorDescriptor[]
): RuntimeEvent[] => {
  const out: RuntimeEvent[] = []
  const nextById = new Map(next.map((f) => [f.floor, f]))
  for (const p of prev) {
    const n = nextById.get(p.floor)
    if (!n) {
      out.push({ name: TAVERN_EVENTS.MESSAGE_DELETED, payload: p.floor })
    } else if (n.swipeId !== p.swipeId) {
      out.push({ name: TAVERN_EVENTS.MESSAGE_SWIPED, payload: p.floor })
    } else if (n.content !== p.content) {
      out.push({ name: TAVERN_EVENTS.MESSAGE_UPDATED, payload: p.floor })
    }
  }
  return out
}
