import { describe, it, expect } from 'vitest'
import { buildDeck, energyCostFor } from '../../../src/shared/combat/deckbuilder/deckBuild'
import { DEFAULT_DECK_CONFIG } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { AbilityDef, Combatant } from '../../../src/shared/combat/types'

const lead = (): Combatant => ({
  id: '主角', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['主角/普攻', '主角/烈焰斩'] },
  ext: { system: 'poemD20', attrs: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, tier: 2 }
})
const catalog: Record<string, AbilityDef> = {
  '主角/普攻': { id: '主角/普攻', name: '普攻', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 20, 关联属性: '力量' } },
  '主角/烈焰斩': { id: '主角/烈焰斩', name: '烈焰斩', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 140, 关联属性: '智力', 品质: '史诗' } }
}

describe('energyCostFor', () => {
  it('basics cost 1; skills cost by 品质', () => {
    expect(energyCostFor(catalog['主角/普攻'], DEFAULT_DECK_CONFIG)).toBe(1)
    expect(energyCostFor(catalog['主角/烈焰斩'], DEFAULT_DECK_CONFIG)).toBe(2) // 史诗 → 2
  })
})

describe('buildDeck', () => {
  it('makes basics copies, a synthesized 格挡, and skill copies by 品质', () => {
    const { cards, order, abilities } = buildDeck(lead(), catalog, DEFAULT_DECK_CONFIG)
    const byAbility = (id: string) => order.map((cid) => cards[cid]).filter((c) => c.abilityId === id)
    expect(byAbility('主角/普攻').length).toBe(4)          // basics.普攻
    expect(byAbility('主角/格挡').length).toBe(4)          // basics.格挡 (synthesized)
    expect(byAbility('主角/烈焰斩').length).toBe(1)        // 史诗 → 1 copy
    // the synthesized 格挡 ability is returned for the catalog, granting maxHp×0.05 护盾
    expect(abilities['主角/格挡']).toMatchObject({ name: '格挡' })
    expect((abilities['主角/格挡'].ext as any).护盾).toBe(50) // round(1000 × 0.05)
    // every card carries owner + a positive energy cost + a unique id
    expect(order.length).toBe(9)
    expect(new Set(order).size).toBe(9)
    for (const cid of order) {
      expect(cards[cid].owner).toBe('主角')
      expect(cards[cid].energyCost).toBeGreaterThan(0)
    }
  })

  it('guards against duplicate ability ids in block.abilities', () => {
    const combatant: Combatant = {
      id: '主角', side: 'party', name: '主角', pos: [0, 0],
      block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['主角/普攻', '主角/普攻'] },
      ext: { system: 'poemD20', attrs: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, tier: 2 }
    }
    const { cards, order } = buildDeck(combatant, catalog, DEFAULT_DECK_CONFIG)
    const byAbility = (id: string) => order.map((cid) => cards[cid]).filter((c) => c.abilityId === id)
    // 普攻 should still appear exactly once with 4 copies (not 8 from duplicated entry)
    expect(byAbility('主角/普攻').length).toBe(4)
    // all card ids must be unique
    expect(new Set(order).size).toBe(order.length)
  })
})
