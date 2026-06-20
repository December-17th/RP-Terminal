import { describe, it, expect } from 'vitest'
import { applyEvent, composeAddendum } from '../src/main/services/generationService'

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
