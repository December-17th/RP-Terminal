import { describe, it, expect } from 'vitest'
import { weightedPolicy } from '../../src/shared/combat/policy'
import type { AbilityDef, Combatant, Coord, CombatState } from '../../src/shared/combat/types'

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
  block: {
    hp: 10,
    maxHp: 10,
    ac: 10,
    speed: 6,
    mods: {},
    abilities: ['slash'],
    conditions: [],
    ...block
  }
})

const state = (combatants: Combatant[], grid = { w: 5, h: 5, cellFt: 5 }): CombatState => ({
  seed: 1,
  rngCursor: 0,
  grid,
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
const cat = { slash }

const dist = (a: Coord, b: Coord): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))

describe('weightedPolicy', () => {
  it('attacks an in-range foe', () => {
    const s = state([C('e', 'enemy', [1, 1], { mods: { STR: 3 } }), C('p', 'party', [1, 2])])
    const a = weightedPolicy(s, 'e', cat)
    expect(a.kind).toBe('ability')
    expect(a.targetIds).toEqual(['p'])
  })

  it('focuses the foe it can kill', () => {
    const s = state([
      C('e', 'enemy', [1, 1], { mods: { STR: 3 } }),
      C('weak', 'party', [0, 1], { hp: 5 }), // avg 6.5 dmg ≥ 5 → securable kill
      C('tough', 'party', [2, 1], { hp: 10 })
    ])
    const a = weightedPolicy(s, 'e', cat)
    expect(a.kind).toBe('ability')
    expect(a.targetIds).toEqual(['weak'])
  })

  it('closes on a distant foe when nothing is in range', () => {
    const s = state([C('e', 'enemy', [0, 0], { speed: 2 }), C('p', 'party', [4, 4])])
    const a = weightedPolicy(s, 'e', cat)
    expect(a.kind).toBe('move')
    expect(dist(a.to as Coord, [4, 4])).toBeLessThan(dist([0, 0], [4, 4]))
  })

  it('flees from the nearest foe when badly hurt', () => {
    const s = state([C('e', 'enemy', [1, 1], { hp: 2 }), C('p', 'party', [0, 1])])
    const a = weightedPolicy(s, 'e', cat)
    expect(a.kind).toBe('move')
    expect(dist(a.to as Coord, [0, 1])).toBeGreaterThan(dist([1, 1], [0, 1]))
  })

  it('ends the turn when there are no foes', () => {
    const s = state([C('e', 'enemy', [1, 1]), C('ally', 'enemy', [2, 2])])
    expect(weightedPolicy(s, 'e', cat).kind).toBe('end')
  })
})
