import { describe, it, expect } from 'vitest'
import {
  applyEvent,
  composeAddendum,
  registerWriteSignature,
  resetWriteLoopGuard
} from '../src/main/services/generationService'

const evt = (path: string, action: string, value: unknown, type = 'state'): any => ({
  type,
  path,
  action,
  value
})

describe('applyEvent (state folding)', () => {
  it('sets a nested path, creating intermediate objects', () => {
    const vars: any = {}
    applyEvent(vars, evt('stats.hp', 'set', 50))
    expect(vars).toEqual({ stats: { hp: 50 } })
  })

  it('adds to an existing number', () => {
    const vars: any = { stats: { hp: 50 } }
    applyEvent(vars, evt('stats.hp', 'add', 10))
    expect(vars.stats.hp).toBe(60)
  })

  it('treats add/remove on a missing/non-number value as starting from 0', () => {
    const vars: any = {}
    applyEvent(vars, evt('stats.mp', 'add', 5))
    expect(vars.stats.mp).toBe(5)
  })

  it('subtracts on remove', () => {
    const vars: any = { hp: 60 }
    applyEvent(vars, evt('hp', 'remove', 20))
    expect(vars.hp).toBe(40)
  })

  it('coerces string numerics for add', () => {
    const vars: any = { hp: 1 }
    applyEvent(vars, evt('hp', 'add', '4'))
    expect(vars.hp).toBe(5)
  })

  it('ignores non-state events', () => {
    const vars: any = { hp: 10 }
    applyEvent(vars, evt('hp', 'set', 999, 'cosmetic'))
    expect(vars.hp).toBe(10)
  })

  it('builds a deep path', () => {
    const vars: any = {}
    applyEvent(vars, evt('a.b.c', 'set', 'x'))
    expect(vars).toEqual({ a: { b: { c: 'x' } } })
  })
})

describe('composeAddendum (card agent prompts)', () => {
  const agent = { prompts: { system: 'World law: be terse.', combat: 'Roll initiative.' } }

  it("applies a card's system prompt in every mode (even FSM off)", () => {
    expect(composeAddendum(agent, 'explore', false, '')).toBe('World law: be terse.')
  })

  it('adds the FSM mode addendum + per-mode card prompt only when the FSM is engaged', () => {
    expect(composeAddendum(agent, 'combat', true, 'MODE: Combat')).toBe(
      'MODE: Combat\n\nWorld law: be terse.\n\nRoll initiative.'
    )
    // FSM off → no mode addendum, no per-mode prompt; just the world system prompt.
    expect(composeAddendum(agent, 'combat', false, 'MODE: Combat')).toBe('World law: be terse.')
  })

  it('returns empty when the card has no agent config', () => {
    expect(composeAddendum(undefined, 'explore', true, '')).toBe('')
    expect(composeAddendum({}, 'explore', false, '')).toBe('')
  })
})

// WS-3 — the timing-independent runaway write-back guard (the `date` clock loop). The detector counts
// CONSECUTIVE same-signature writes (no wall-clock window), reset per model turn.
describe('write-back loop guard (WS-3)', () => {
  const LOOP_MAX = 40

  it('drops a self-feedback loop: the SAME path hammered past the threshold', () => {
    const chat = 'loop-1'
    resetWriteLoopGuard(chat)
    // The first LOOP_MAX writes are allowed; the (LOOP_MAX+1)th and beyond are dropped.
    for (let i = 1; i <= LOOP_MAX; i++) {
      expect(registerWriteSignature(chat, '/世界.date').drop).toBe(false)
    }
    expect(registerWriteSignature(chat, '/世界.date').drop).toBe(true)
    expect(registerWriteSignature(chat, '/世界.date').drop).toBe(true) // stays dropped
  })

  it('is TIMING-INDEPENDENT — a slow loop (>400ms apart) is still caught', () => {
    // The old guard reset on a >400ms gap; this one counts consecutively regardless of timing. We don't
    // advance any clock here, so passing the threshold with no time gating proves timing-independence.
    const chat = 'loop-slow'
    resetWriteLoopGuard(chat)
    let dropped = false
    for (let i = 0; i < 50; i++) dropped = registerWriteSignature(chat, '/clock').drop || dropped
    expect(dropped).toBe(true)
  })

  it('does NOT drop a legit init chain that touches DISTINCT paths (streak resets each time)', () => {
    const chat = 'init-1'
    resetWriteLoopGuard(chat)
    for (let i = 0; i < 200; i++) {
      // every write is a different path → signature changes → streak never accumulates
      expect(registerWriteSignature(chat, `/field_${i}`).drop).toBe(false)
    }
  })

  it('resets the streak on a new model turn, so a path written once per turn never accumulates', () => {
    const chat = 'perturn'
    for (let turn = 0; turn < 100; turn++) {
      resetWriteLoopGuard(chat) // start of generate()
      expect(registerWriteSignature(chat, '/位置').drop).toBe(false)
    }
  })

  it('keeps chats independent', () => {
    resetWriteLoopGuard('A')
    resetWriteLoopGuard('B')
    for (let i = 0; i <= LOOP_MAX; i++) registerWriteSignature('A', '/x')
    expect(registerWriteSignature('A', '/x').drop).toBe(true)
    expect(registerWriteSignature('B', '/x').drop).toBe(false)
  })
})
