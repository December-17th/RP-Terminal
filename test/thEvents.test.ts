import { describe, it, expect } from 'vitest'
import {
  TAVERN_EVENTS,
  TAVERN_EVENTS_LITERAL,
  chatTransitionEvents,
  messageMutationEvents
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

describe('messageMutationEvents (TH-2)', () => {
  const f = (floor: number, content: string, swipeId = 0) => ({ floor, content, swipeId })

  it('emits MESSAGE_DELETED for floors that disappear', () => {
    const evs = messageMutationEvents([f(0, 'a'), f(1, 'b')], [f(0, 'a')])
    expect(evs).toEqual([{ name: TAVERN_EVENTS.MESSAGE_DELETED, payload: 1 }])
  })

  it('emits MESSAGE_SWIPED when the active swipe index changes', () => {
    const evs = messageMutationEvents([f(0, 'a', 0)], [f(0, 'b', 1)])
    expect(evs).toEqual([{ name: TAVERN_EVENTS.MESSAGE_SWIPED, payload: 0 }])
  })

  it('emits MESSAGE_UPDATED when only the text changes', () => {
    const evs = messageMutationEvents([f(0, 'a', 0)], [f(0, 'a2', 0)])
    expect(evs).toEqual([{ name: TAVERN_EVENTS.MESSAGE_UPDATED, payload: 0 }])
  })

  it('emits nothing for unchanged floors or pure appends', () => {
    expect(messageMutationEvents([f(0, 'a')], [f(0, 'a')])).toEqual([])
    expect(messageMutationEvents([f(0, 'a')], [f(0, 'a'), f(1, 'b')])).toEqual([])
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

describe('sandbox shim wiring (TH-2)', () => {
  const doc = buildScriptSrcDoc([{ name: 's', code: 'noop()' }])

  it('exposes the message + variable-scope helpers on the TH shim', () => {
    for (const name of [
      'insertVariables',
      'deleteVariable',
      'getChatMessages',
      'setChatMessages',
      'createChatMessages',
      'deleteChatMessages'
    ]) {
      expect(doc).toContain(name)
    }
  })

  it('exposes the low-level scoped var op + message-write methods on the rpt bridge', () => {
    expect(doc).toContain('var: function (action)')
    expect(doc).toContain('setMessage:')
    expect(doc).toContain('createMessage:')
    expect(doc).toContain('deleteMessages:')
  })
})

describe('sandbox shim wiring (TH-3)', () => {
  const doc = buildScriptSrcDoc([{ name: 's', code: 'noop()' }])

  it('exposes the read/CRUD namespaces on the rpt bridge', () => {
    expect(doc).toContain('card: {')
    expect(doc).toContain('lore: {')
    expect(doc).toContain('preset: {')
    expect(doc).toContain('regex: {')
  })

  it('maps the TH read/CRUD names onto the bridge', () => {
    for (const name of [
      'getCharData',
      'getWorldbook',
      'getWorldbookNames',
      'replaceWorldbookEntries',
      'getPreset',
      'getTavernRegexes',
      'formatAsTavernRegexedString'
    ]) {
      expect(doc).toContain(name)
    }
  })
})
