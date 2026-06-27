// src/renderer/src/cardBridge/hostBroadcast.ts
//
// The ONE place a TavernHelper host event fans out to BOTH card transports — WCV cards over IPC
// (wcv-event) and inline cards over the renderer bus (cardHostEvents). Previously App.tsx emitted to
// each transport by hand at every call site (WS-7), so adding an event risked wiring only one path and
// silently breaking the other. Route every host-event broadcast through here so the transports can't drift.
import { useChatStore } from '../stores/chatStore'
import { emitCardHostEvent } from './cardHostEvents'
import { chatTransitionEvents, messageMutationEvents } from '../plugin/events'

/** Broadcast one host event to BOTH transports. Use this instead of calling the two channels directly. */
export function broadcastHostEvent(chatId: string, name: string, payload?: unknown): void {
  window.api.wcvBroadcastEvent(chatId, name, payload)
  emitCardHostEvent(name, payload)
}

/**
 * Wire the chat-store → host-event bridge: compute the generation/message lifecycle events from each
 * store transition (reusing the same pure functions the iframe scripts use) and broadcast them to both
 * transports. Returns a disposer. Lifted out of App.tsx so the compute+broadcast logic lives together.
 */
export function initCardEventBridge(): () => void {
  return useChatStore.subscribe((state, prev) => {
    const chatId = state.activeChatId
    if (!chatId) return
    const toDesc = (
      fs: typeof state.floors
    ): { floor: number; content: string; swipeId: number }[] =>
      fs.map((f) => ({ floor: f.floor, content: f.response.content, swipeId: f.swipe_id ?? 0 }))
    const events = [
      ...chatTransitionEvents(
        { isGenerating: prev.isGenerating, floorCount: prev.floors.length },
        { isGenerating: state.isGenerating, floorCount: state.floors.length }
      ),
      ...messageMutationEvents(toDesc(prev.floors), toDesc(state.floors))
    ]
    for (const ev of events) broadcastHostEvent(chatId, ev.name, ev.payload)
  })
}
