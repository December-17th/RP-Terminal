import { describe, it, expect } from 'vitest'
import {
  TAVERN_EVENTS,
  TAVERN_EVENTS_LITERAL,
  chatTransitionEvents
} from '../src/renderer/src/plugin/events'
import { buildScriptSrcDoc } from '../src/renderer/src/plugin/bridgeShim'

describe('TAVERN_EVENTS (TH-1 canonical enum)', () => {
  it('exposes the core ST/TH event names as snake_case values', () => {
    expect(TAVERN_EVENTS.GENERATION_STARTED).toBe('generation_started')
    expect(TAVERN_EVENTS.GENERATION_ENDED).toBe('generation_ended')
    expect(TAVERN_EVENTS.MESSAGE_SENT).toBe('message_sent')
    expect(TAVERN_EVENTS.MESSAGE_RECEIVED).toBe('message_received')
    expect(TAVERN_EVENTS.MESSAGE_UPDATED).toBe('message_updated')
    expect(TAVERN_EVENTS.MESSAGE_DELETED).toBe('message_deleted')
    expect(TAVERN_EVENTS.MESSAGE_SWIPED).toBe('message_swiped')
    expect(TAVERN_EVENTS.CHAT_CHANGED).toBe('chat_changed')
    expect(TAVERN_EVENTS.STREAM_TOKEN_RECEIVED).toBe('stream_token_received')
  })

  it('serializes losslessly to the literal injected into the shim', () => {
    expect(JSON.parse(TAVERN_EVENTS_LITERAL)).toEqual(TAVERN_EVENTS)
  })
})

describe('chatTransitionEvents', () => {
  const base = { isGenerating: false, floorCount: 0 }

  it('emits both legacy + canonical names when generation starts', () => {
    const evs = chatTransitionEvents(base, { isGenerating: true, floorCount: 0 })
    expect(evs.map((e) => e.name)).toEqual(['generation:start', TAVERN_EVENTS.GENERATION_STARTED])
  })

  it('emits both legacy + canonical names when generation ends', () => {
    const evs = chatTransitionEvents({ isGenerating: true, floorCount: 1 }, {
      isGenerating: false,
      floorCount: 1
    })
    expect(evs.map((e) => e.name)).toEqual(['generation:end', TAVERN_EVENTS.GENERATION_ENDED])
  })

  it('emits chat:changed + MESSAGE_RECEIVED (with the new floor index) when a floor lands', () => {
    const evs = chatTransitionEvents({ isGenerating: true, floorCount: 0 }, {
      isGenerating: false,
      floorCount: 1
    })
    expect(evs.map((e) => e.name)).toEqual([
      'generation:end',
      TAVERN_EVENTS.GENERATION_ENDED,
      'chat:changed',
      TAVERN_EVENTS.MESSAGE_RECEIVED
    ])
    const received = evs.find((e) => e.name === TAVERN_EVENTS.MESSAGE_RECEIVED)
    expect(received?.payload).toBe(0)
  })

  it('emits chat:changed (no MESSAGE_RECEIVED) when the floor count shrinks', () => {
    const evs = chatTransitionEvents({ isGenerating: false, floorCount: 3 }, base)
    expect(evs.map((e) => e.name)).toEqual(['chat:changed'])
  })

  it('emits nothing for a no-op transition', () => {
    expect(chatTransitionEvents(base, base)).toEqual([])
  })
})

describe('sandbox shim wiring (TH-1)', () => {
  const doc = buildScriptSrcDoc([{ name: 's', code: 'noop()' }])

  it('injects the tavern_events enum into the iframe document', () => {
    expect(doc).toContain('var tavern_events =')
    expect(doc).toContain('"GENERATION_STARTED":"generation_started"')
    expect(doc).toContain('window.tavern_events = tavern_events')
  })

  it('wires the event-ordering helpers onto the TH shim', () => {
    expect(doc).toContain('eventMakeFirst')
    expect(doc).toContain('eventMakeLast')
    expect(doc).toContain('eventWaitFor')
    expect(doc).toContain('eventRemoveListener')
  })

  it('exposes the ordering primitives on the rpt bridge', () => {
    expect(doc).toContain('onFirst:')
    expect(doc).toContain('waitFor:')
    expect(doc).toContain('once:')
  })
})
