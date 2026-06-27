import { describe, it, expect } from 'vitest'
import {
  resolveAbility,
  applyDamageAmount,
  tickConditions,
  isAlive
} from '../../src/shared/combat/resolver'
import type { AbilityDef, Combatant, Coord, CombatState } from '../../src/shared/combat/types'

const seq = (vals: number[]): (() => number) => {
  let i = 0
  return () => vals[i++ % vals.length]
}

const C = (
  id: string,
  side: Combatant['side'],
  pos: Coord,
  block: Partial<Combatant['block']> = {}
): Combatant => ({
  id,
  side,
  name: id,
  pos,
  block: { hp: 10, maxHp: 10, ac: 10, speed: 6, mods: {}, abilities: [], conditions: [], ...block }
})

const state = (combatants: Combatant[]): CombatState => ({
  seed: 1,
  rngCursor: 0,
  grid: { w: 10, h: 10, cellFt: 5 },
  combatants,
  initiative: [],
  turnIndex: 0,
  round: 1,
  log: [],
  status: 'active'
})

const slash: AbilityDef = {
  id: 'slash',
  name: 'Slash',
  range: 1,
  shape: { kind: 'self' },
  toHit: 'STR',
  damage: '1d6+STR',
  damageType: 'slashing'
}

const fireball: AbilityDef = {
  id: 'fb',
  name: 'Fireball',
  range: 5,
  shape: { kind: 'burst', r: 1 },
  toHit: null,
  save: { ability: 'DEX', dc: 12, onSuccess: 0.5 },
  damage: '2d6',
  damageType: 'fire'
}

describe('resolveAbility — attack', () => {
  it('hits and deals damage', () => {
    const s = state([C('a', 'party', [0, 0], { mods: { STR: 3 } }), C('e', 'enemy', [1, 0])])
    const ev = resolveAbility(
      s,
      { kind: 'ability', actor: 'a', abilityId: 'slash', targetIds: ['e'] },
      { slash },
      seq([0.9, 0.5])
    )
    const dmg = ev.find((e) => e.kind === 'damage')
    expect(dmg?.delta?.damage).toBe(7) // d6→4 + STR 3
    expect(s.combatants[1].block.hp).toBe(3)
  })

  it('misses on a fumble', () => {
    const s = state([C('a', 'party', [0, 0], { mods: { STR: 3 } }), C('e', 'enemy', [1, 0])])
    const ev = resolveAbility(
      s,
      { kind: 'ability', actor: 'a', abilityId: 'slash', targetIds: ['e'] },
      { slash },
      seq([0])
    )
    expect(ev.some((e) => e.kind === 'miss')).toBe(true)
    expect(s.combatants[1].block.hp).toBe(10)
  })

  it('emits a death event when HP hits 0', () => {
    const s = state([
      C('a', 'party', [0, 0], { mods: { STR: 3 } }),
      C('e', 'enemy', [1, 0], { hp: 3, maxHp: 3 })
    ])
    const ev = resolveAbility(
      s,
      { kind: 'ability', actor: 'a', abilityId: 'slash', targetIds: ['e'] },
      { slash },
      seq([0.9, 0.9])
    )
    expect(s.combatants[1].block.hp).toBe(0)
    expect(ev.some((e) => e.kind === 'death')).toBe(true)
  })

  it('applies conditions on a hit', () => {
    const withProne: AbilityDef = { ...slash, effects: [{ id: 'prone', duration: 2 }] }
    const s = state([C('a', 'party', [0, 0], { mods: { STR: 3 } }), C('e', 'enemy', [1, 0])])
    resolveAbility(
      s,
      { kind: 'ability', actor: 'a', abilityId: 'slash', targetIds: ['e'] },
      { slash: withProne },
      seq([0.9, 0.5])
    )
    expect(s.combatants[1].block.conditions.map((c) => c.id)).toContain('prone')
  })
})

describe('resolveAbility — save-based AoE', () => {
  it('deals half damage on a successful save', () => {
    const s = state([C('a', 'party', [0, 0]), C('e', 'enemy', [2, 2], { hp: 20, maxHp: 20 })])
    const ev = resolveAbility(
      s,
      { kind: 'ability', actor: 'a', abilityId: 'fb', targetCell: [2, 2] },
      { fb: fireball },
      seq([0.95, 0.5, 0.5])
    )
    expect(ev.some((e) => e.kind === 'save' && e.delta?.success === true)).toBe(true)
    expect(s.combatants[1].block.hp).toBe(16) // 2d6 = 8, halved → 4
  })

  it('is out of range when the target cell is too far', () => {
    const s = state([C('a', 'party', [0, 0]), C('e', 'enemy', [9, 9], { hp: 20, maxHp: 20 })])
    const ev = resolveAbility(
      s,
      { kind: 'ability', actor: 'a', abilityId: 'fb', targetCell: [9, 9] },
      { fb: fireball },
      seq([0.5])
    )
    expect(ev.some((e) => e.kind === 'info')).toBe(true)
    expect(s.combatants[1].block.hp).toBe(20)
  })
})

describe('requiresLoS', () => {
  // A 5x1 lane with a sight-blocking wall at x=2, between the shooter and the target.
  const lane = (): CombatState => {
    const tiles = Array.from({ length: 5 }, () => ({
      passable: true,
      blocksLoS: false,
      difficult: false,
      hazard: false
    }))
    tiles[2].blocksLoS = true
    return {
      seed: 1,
      rngCursor: 0,
      grid: { w: 5, h: 1, cellFt: 5, tiles },
      combatants: [
        C('a', 'party', [0, 0], { mods: { DEX: 5 } }),
        C('e', 'enemy', [4, 0], { ac: 1, hp: 10, maxHp: 10 })
      ],
      initiative: ['a', 'e'],
      turnIndex: 0,
      round: 1,
      log: [],
      status: 'active'
    }
  }
  const bolt: AbilityDef = {
    id: 'bolt',
    name: 'Bolt',
    range: 6,
    shape: { kind: 'self' },
    toHit: 'DEX',
    damage: '1d8',
    requiresLoS: true
  }

  it('a wall blocks a line-of-sight ability', () => {
    const s = lane()
    const ev = resolveAbility(
      s,
      { kind: 'ability', actor: 'a', abilityId: 'bolt', targetCell: [4, 0] },
      { bolt },
      seq([0.9, 0.5])
    )
    expect(ev.some((e) => e.kind === 'info' && /line of sight/i.test(e.text))).toBe(true)
    expect(s.combatants[1].block.hp).toBe(10) // unscathed
  })

  it('a lobbed ability (requiresLoS false) ignores the wall', () => {
    const s = lane()
    resolveAbility(
      s,
      { kind: 'ability', actor: 'a', abilityId: 'lob', targetCell: [4, 0] },
      { lob: { ...bolt, id: 'lob', requiresLoS: false } },
      seq([0.9, 0.5])
    )
    expect(s.combatants[1].block.hp).toBeLessThan(10)
  })
})

describe('applyDamageAmount / tickConditions / isAlive', () => {
  it('applies resistance and vulnerability', () => {
    expect(applyDamageAmount(C('t', 'enemy', [0, 0], { resist: ['fire'] }), 7, 'fire')).toBe(3)
    expect(applyDamageAmount(C('t', 'enemy', [0, 0], { vulnerable: ['fire'] }), 7, 'fire')).toBe(14)
    expect(applyDamageAmount(C('t', 'enemy', [0, 0]), 7, 'fire')).toBe(7)
  })

  it('ticks timed conditions and keeps permanent ones', () => {
    const c = C('x', 'enemy', [0, 0], {
      conditions: [
        { id: 'a', duration: 2 },
        { id: 'b', duration: 1 },
        { id: 'c', duration: -1 }
      ]
    })
    tickConditions(c)
    expect(c.block.conditions.map((x) => `${x.id}:${x.duration}`)).toEqual(['a:1', 'c:-1'])
  })

  it('isAlive tracks positive HP', () => {
    expect(isAlive(C('x', 'enemy', [0, 0], { hp: 1 }))).toBe(true)
    expect(isAlive(C('x', 'enemy', [0, 0], { hp: 0 }))).toBe(false)
  })
})
