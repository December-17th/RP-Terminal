import { describe, it, expect } from 'vitest'
import { makeRng, rollDie, rollD20, rollExpr } from '../../src/shared/combat/dice'

// A deterministic rng that replays a fixed sequence (looping) — lets tests force
// exact die faces without depending on the PRNG's internals.
const seq = (vals: number[]): (() => number) => {
  let i = 0
  return () => vals[i++ % vals.length]
}

describe('makeRng', () => {
  it('is deterministic for a seed and yields values in [0,1)', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    for (let i = 0; i < 5; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('different seeds diverge', () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)())
  })
})

describe('rollDie', () => {
  it('maps [0,1) onto [1, sides]', () => {
    expect(rollDie(() => 0, 20)).toBe(1)
    expect(rollDie(() => 0.999999, 20)).toBe(20)
    expect(rollDie(() => 0.5, 6)).toBe(4) // floor(3)+1
  })
})

describe('rollD20', () => {
  it('adds the modifier and flags crit/fumble off the natural die', () => {
    const crit = rollD20(() => 0.9999, { mod: 5 })
    expect(crit.natural).toBe(20)
    expect(crit.total).toBe(25)
    expect(crit.crit).toBe(true)
    expect(crit.fumble).toBe(false)

    const fumble = rollD20(() => 0, { mod: 5 })
    expect(fumble.natural).toBe(1)
    expect(fumble.total).toBe(6)
    expect(fumble.fumble).toBe(true)
  })
  it('advantage keeps the higher die, disadvantage the lower', () => {
    expect(rollD20(seq([0, 0.9999]), { adv: true }).natural).toBe(20)
    expect(rollD20(seq([0, 0.9999]), { dis: true }).natural).toBe(1)
    // both flags cancel → a straight single roll
    const straight = rollD20(seq([0.9999, 0]), { adv: true, dis: true })
    expect(straight.dice).toHaveLength(1)
    expect(straight.natural).toBe(20)
  })
})

describe('rollExpr', () => {
  it('rolls dice terms and adds constants', () => {
    const r = rollExpr(() => 0.5, '2d6+3')
    expect(r.rolls).toEqual([4, 4])
    expect(r.modifier).toBe(3)
    expect(r.total).toBe(11)
  })
  it('resolves ability tokens from mods', () => {
    const r = rollExpr(() => 0.5, '1d8+STR', { STR: 2 })
    expect(r.rolls).toEqual([5]) // floor(0.5*8)+1
    expect(r.modifier).toBe(2)
    expect(r.total).toBe(7)
  })
  it('handles subtraction and bare modifiers', () => {
    expect(rollExpr(() => 0.5, '1d4-1').total).toBe(2) // floor(0.5*4)+1=3, -1 → 2
    const bare = rollExpr(() => 0, 'STR', { STR: 3 })
    expect(bare.rolls).toEqual([])
    expect(bare.total).toBe(3)
    expect(rollExpr(() => 0, '').total).toBe(0)
  })
  it('critDice multiplies the dice but not the modifiers', () => {
    const r = rollExpr(() => 0.5, '2d6+3', {}, 2)
    expect(r.rolls).toEqual([4, 4, 4, 4])
    expect(r.modifier).toBe(3)
    expect(r.total).toBe(19)
  })
})
