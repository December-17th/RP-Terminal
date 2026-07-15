import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins the streaming/broadcast contract from the 2026-07 performance work (audit P1-1/P1-2):
//  - the card event bridge forwards STREAM_TOKEN_RECEIVED once per store flush (the rAF-coalesced
//    streamingText), to BOTH transports,
//  - a streamingText-only store fire performs NO history diffing (the floors identity early-out),
//  - floor/lifecycle changes still run the diff and broadcast its events.
const h = vi.hoisted(() => ({
  subscriber: null as null | ((state: any, prev: any) => void),
  emitCardHostEvent: vi.fn(),
  chatTransitionEvents: vi.fn(() => [] as Array<{ name: string; payload?: unknown }>),
  messageMutationEvents: vi.fn(() => [] as Array<{ name: string; payload?: unknown }>),
  wcvBroadcastEvent: vi.fn()
}))

vi.mock('../src/renderer/src/stores/chatStore', () => ({
  useChatStore: {
    subscribe: (cb: (state: any, prev: any) => void) => {
      h.subscriber = cb
      return () => {}
    }
  }
}))
vi.mock('../src/renderer/src/cardBridge/cardHostEvents', () => ({
  emitCardHostEvent: h.emitCardHostEvent
}))
vi.mock('../src/renderer/src/plugin/events', () => ({
  chatTransitionEvents: h.chatTransitionEvents,
  messageMutationEvents: h.messageMutationEvents
}))

import { initCardEventBridge } from '../src/renderer/src/cardBridge/hostBroadcast'

const mkState = (over: Partial<Record<string, unknown>> = {}): any => ({
  activeChatId: 'chat-a',
  floors: [],
  isGenerating: false,
  streamingText: '',
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window = { api: { wcvBroadcastEvent: h.wcvBroadcastEvent } }
  initCardEventBridge()
})

describe('initCardEventBridge — streaming + early-out (perf audit P1-1/P1-2)', () => {
  it('a streamingText-only flush broadcasts ONE stream event to both transports and skips the history diff', () => {
    const floors = [{ floor: 0, response: { content: 'a0' }, swipe_id: 0 }]
    const prev = mkState({ floors, isGenerating: true, streamingText: 'Hel' })
    const state = mkState({ floors, isGenerating: true, streamingText: 'Hello' })
    h.subscriber!(state, prev)

    expect(h.wcvBroadcastEvent).toHaveBeenCalledTimes(1)
    expect(h.wcvBroadcastEvent).toHaveBeenCalledWith('chat-a', 'stream_token_received', 'Hello')
    expect(h.emitCardHostEvent).toHaveBeenCalledWith('stream_token_received', 'Hello')
    // The load-bearing assertion: no full-history mapping/diff on a streaming flush.
    expect(h.chatTransitionEvents).not.toHaveBeenCalled()
    expect(h.messageMutationEvents).not.toHaveBeenCalled()
  })

  it('the end-of-stream reset (streamingText → "") emits no stream event', () => {
    const floors: unknown[] = []
    h.subscriber!(
      mkState({ floors, streamingText: '' }),
      mkState({ floors, streamingText: 'Hello' })
    )
    expect(h.wcvBroadcastEvent).not.toHaveBeenCalled()
  })

  it('a floors change still runs the diff and broadcasts its events', () => {
    h.chatTransitionEvents.mockReturnValue([{ name: 'generation_ended', payload: 1 }])
    const prevFloors = [{ floor: 0, response: { content: 'a0' }, swipe_id: 0 }]
    const nextFloors = [...prevFloors, { floor: 1, response: { content: 'a1' }, swipe_id: 0 }]
    h.subscriber!(mkState({ floors: nextFloors }), mkState({ floors: prevFloors }))

    expect(h.chatTransitionEvents).toHaveBeenCalledTimes(1)
    expect(h.messageMutationEvents).toHaveBeenCalledTimes(1)
    expect(h.wcvBroadcastEvent).toHaveBeenCalledWith('chat-a', 'generation_ended', 1)
    expect(h.emitCardHostEvent).toHaveBeenCalledWith('generation_ended', 1)
  })

  it('does nothing without an active chat', () => {
    h.subscriber!(mkState({ activeChatId: null, streamingText: 'x' }), mkState())
    expect(h.wcvBroadcastEvent).not.toHaveBeenCalled()
    expect(h.chatTransitionEvents).not.toHaveBeenCalled()
  })
})
