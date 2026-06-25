import { describe, it, expect } from 'vitest'
import { parseEnemyCue, buildEncounter, type CombatBundle } from '../../src/shared/combat/bundle'
import { CombatBundleSchema } from '../../src/main/types/character'

const bundle: CombatBundle = {
  enemy_controller: 'weighted',
  abilities: [
    { id: 'slash', name: 'Slash', range: 1, shape: { kind: 'self' }, toHit: 'STR', damage: '1d6' }
  ],
  bestiary: [
    {
      id: 'goblin',
      name: 'Goblin',
      block: { hp: 7, ac: 13, speed: 6, mods: { STR: 1 } },
      abilities: ['slash']
    }
  ],
  party: [
    {
      id: 'hero',
      name: 'Hero',
      block: { hp: 20, ac: 15, speed: 6, mods: { STR: 3 } },
      abilities: ['slash']
    }
  ],
  maps: [
    {
      id: 'm1',
      w: 8,
      h: 6,
      cell_ft: 5,
      party_spawns: [[1, 1]],
      enemy_spawns: [
        [6, 1],
        [6, 2]
      ]
    }
  ],
  scripts: { resolveAction: 'return null' }
}

describe('parseEnemyCue', () => {
  it('parses refs, counts, and strips tier parentheticals', () => {
    expect(parseEnemyCue('哥布林 x3 (弱); 头目')).toEqual([
      { ref: '哥布林', count: 3 },
      { ref: '头目', count: 1 }
    ])
    expect(parseEnemyCue('goblin x2, orc')).toEqual([
      { ref: 'goblin', count: 2 },
      { ref: 'orc', count: 1 }
    ])
    expect(parseEnemyCue('')).toEqual([])
  })
})

describe('buildEncounter', () => {
  it('builds party + cue-resolved enemies on the bundle map', () => {
    const built = buildEncounter(bundle, { enemies: 'goblin x2', map: 'm1' })
    expect(built.grid).toEqual({ w: 8, h: 6, cellFt: 5 })
    expect(built.combatants.map((c) => c.id)).toEqual(['hero', 'goblin-1', 'goblin-2'])
    const hero = built.combatants[0]
    expect(hero.side).toBe('party')
    expect(hero.pos).toEqual([1, 1])
    expect(hero.block.maxHp).toBe(20) // defaulted from hp
    const g1 = built.combatants[1]
    expect(g1.side).toBe('enemy')
    expect(g1.controller).toBe('weighted')
    expect(g1.pos).toEqual([6, 1])
    expect(built.abilities.slash.name).toBe('Slash')
    expect(built.hooks.resolveAction).toBe('return null')
  })

  it('skips unknown enemy refs and falls back to the first map', () => {
    const built = buildEncounter(bundle, { enemies: 'dragon x1' })
    expect(built.combatants.map((c) => c.id)).toEqual(['hero'])
  })

  it('uses a default grid when the bundle ships no maps', () => {
    const built = buildEncounter({ party: [{ id: 'h', block: { hp: 10 } }] }, null)
    expect(built.grid).toEqual({ w: 10, h: 8, cellFt: 5 })
    expect(built.combatants.map((c) => c.id)).toEqual(['h'])
  })
})

describe('CombatBundleSchema', () => {
  it('parses a full bundle and an empty one (permissive)', () => {
    expect(() => CombatBundleSchema.parse(bundle)).not.toThrow()
    expect(() => CombatBundleSchema.parse({})).not.toThrow()
  })
})
