// src/renderer/src/cardBridge/cardHostEvents.ts
//
// Renderer-local event bus carrying the TavernHelper lifecycle/mutation/stream events from the renderer hub
// (App.tsx) to INLINE cards. WCV cards already get the same events over IPC (wcv-event); inline cards run in
// the renderer, so a module singleton is the right channel. The inline Host adapter's `onHostEvent`
// subscribes here; App.tsx emits (alongside its WCV broadcast) from the one place the events are computed,
// so both transports deliver the same events with no recomputation/drift.
type CardHostEventCb = (name: string, payload?: unknown) => void

const subs = new Set<CardHostEventCb>()

/** Emit a host event to every subscribed inline card (one throwing subscriber can't break the others). */
export function emitCardHostEvent(name: string, payload?: unknown): void {
  for (const cb of subs) {
    try {
      cb(name, payload)
    } catch (e) {
      console.error('[card host event]', name, e)
    }
  }
}

/** Subscribe to host events; returns an unsubscribe. */
export function onCardHostEvent(cb: CardHostEventCb): () => void {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}
