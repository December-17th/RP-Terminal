import { describe, it, expect } from 'vitest'
import { reachable, lineOfSight } from '../../src/shared/combat/grid'
import { resolveAbility } from '../../src/shared/combat/resolver'
import { weightedPolicy } from '../../src/shared/combat/policy'
import type {
  AbilityDef,
  Combatant,
  Condition,
  Coord,
  CombatState,
  TileFlags
} from '../../src/shared/combat/types'

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
  initiative: combatants.map((c) => c.id),
  turnIndex: 0,
  round: 1,
  log: [],
  status: 'active'
})

const prone: Condition = { id: 'prone', duration: 1 }
const stunned: Condition = { id: 'stunned', duration: 1 }
const restrained: Condition = { id: 'restrained', duration: 1 }

// A high-AC attack ability so advantage flips the outcome.
const jab: AbilityDef = {
  id: 'slash',
  name: 'Jab',
  range: 1,
  shape: { kind: 'self' },
  toHit: 'STR',
  damage: '1d6'
}

describe('lineOfSight', () => {
  const wall = (cells: Coord[]): { w: number; h: number; cellFt: number; tiles: TileFlags[] } => {
    const tiles = Array.from({ length: 25 }, () => ({
      passable: true,
      blocksLoS: false,
      difficult: false,
      hazard: false
    }))
    for (const [x, y] of cells) tiles[y * 5 + x].blocksLoS = true
    return { w: 5, h: 5, cellFt: 5, tiles }
  }
  it('is clear across open ground', () => {
    expect(lineOfSight({ w: 5, h: 5, cellFt: 5 }, [0, 0], [4, 4])).toBe(true)
  })
  it('is blocked by an obstacle between the cells', () => {
    expect(lineOfSight(wall([[2, 0]]), [0, 0], [4, 0])).toBe(false)
  })
  it('endpoints themselves never block', () => {
    expect(lineOfSight(wall([[4, 0]]), [0, 0], [4, 0])).toBe(true)
  })
})

describe('immobilizing conditions', () => {
  it('zero out movement', () => {
    expect(
      reachable(state([C('a', 'party', [2, 2])]).grid, [C('a', 'party', [2, 2])], 'a').length
    ).toBeGreaterThan(0)
    expect(
      reachable(
        { w: 5, h: 5, cellFt: 5 },
        [C('a', 'party', [2, 2], { conditions: [stunned] })],
        'a'
      )
    ).toEqual([])
    expect(
      reachable(
        { w: 5, h: 5, cellFt: 5 },
        [C('a', 'party', [2, 2], { conditions: [restrained] })],
        'a'
      )
    ).toEqual([])
  })
})

describe('prone grants attackers advantage', () => {
  it('a prone target is hit where a standing one is missed (same rolls)', () => {
    const standing = state([C('hero', 'party', [0, 0]), C('e', 'enemy', [1, 0], { ac: 18 })])
    const missEv = resolveAbility(
      standing,
      { kind: 'ability', actor: 'hero', abilityId: 'slash', targetIds: ['e'] },
      { slash: jab },
      seq([0.1])
    )
    expect(missEv.some((x) => x.kind === 'miss')).toBe(true)
    expect(standing.combatants[1].block.hp).toBe(10)

    const onGround = state([
      C('hero', 'party', [0, 0]),
      C('e', 'enemy', [1, 0], { ac: 18, conditions: [prone] })
    ])
    resolveAbility(
      onGround,
      { kind: 'ability', actor: 'hero', abilityId: 'slash', targetIds: ['e'] },
      { slash: jab },
      seq([0.1, 0.95, 0.5]) // advantage takes the 0.95 die → hit
    )
    expect(onGround.combatants[1].block.hp).toBeLessThan(10)
  })
})

describe('stunned skips the turn', () => {
  it('a stunned combatant ends its turn', () => {
    const s = state([
      C('g', 'enemy', [1, 1], { conditions: [stunned], mods: { STR: 3 } }),
      C('p', 'party', [1, 2])
    ])
    expect(weightedPolicy(s, 'g', { slash: jab }).kind).toBe('end')
  })
})
