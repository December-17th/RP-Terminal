// test/combat/deckbuilder/deckEngine.test.ts
import { describe, it, expect } from 'vitest'
import { startDuel, playCard, endLeadTurn, checkDuelVictory, swapLeadIfDown } from '../../../src/shared/combat/deckbuilder/deckEngine'
import { DEFAULT_DECK_CONFIG } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { BuiltEncounter } from '../../../src/shared/combat/bundle'
import type { AbilityDef, Combatant } from '../../../src/shared/combat/types'

const derive = { tier_coefficient: { '2': 2.8 }, rating_tiers: [[1, 1.0], [0, 0]] as [number, number][], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

const lead = (): Combatant => ({
  id: '主角', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['主角/普攻'] },
  ext: { system: 'poemD20', attrs: { 力量: 5, 体质: 6 }, tier: 2, mp: 100, sp: 100, equip: { 武器攻击: 60, 防御: 0 }, shield: 0 }
})
const foe = (hp = 60): Combatant => ({
  id: '哥布林', side: 'enemy', name: '哥布林', pos: [1, 0],
  block: { hp, maxHp: 300, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['哥布林/横扫'] },
  ext: { system: 'poemD20', attrs: { 力量: 3, 体质: 4 }, tier: 2, equip: { 武器攻击: 20, 防御: 0 } }
})
const catalog: Record<string, AbilityDef> = {
  '主角/普攻': { id: '主角/普攻', name: '普攻', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 20, 关联属性: '力量' } },
  '哥布林/横扫': { id: '哥布林/横扫', name: '横扫', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 80, 关联属性: '力量' } }
}
const built = (combatants: Combatant[]): BuiltEncounter => ({ seed: 7, grid: { w: 1, h: 1, cellFt: 5 }, combatants, abilities: catalog, hooks: {} })

describe('startDuel', () => {
  it('builds a shared deck, draws an opening hand, and telegraphs enemy intents', () => {
    const { state } = startDuel(built([lead(), foe()]), { seed: 7, config: DEFAULT_DECK_CONFIG })
    expect(state.lead).toBe('主角')
    expect(state.energy).toEqual({ current: 3, max: 3 })
    expect(state.piles.hand.length).toBe(5)                 // handSize
    // deck = 4 普攻 + 4 格挡 = 8; 5 drawn, 3 left.
    expect(state.piles.draw.length).toBe(3)
    expect(state.intents['哥布林']?.kind).toBe('attack')
    expect(state.intents['哥布林']?.target).toBe('主角')
  })
})

describe('playCard', () => {
  it('rejects a card not in hand', () => {
    const { state } = startDuel(built([lead(), foe()]), { seed: 7 })
    const out = playCard(state, 'nope#1', ['哥布林'], catalog, derive)
    expect(out.events.some((e) => e.kind === 'info')).toBe(true)
    expect(out.state.energy.current).toBe(3)               // unchanged
  })

  it('plays a hand card, spends energy, and can win the duel', () => {
    const { state } = startDuel(built([lead(), foe(40)]), { seed: 7 })
    const cardId = state.piles.hand.find((id) => state.cards[id].abilityId === '主角/普攻')!
    const out = playCard(state, cardId, ['哥布林'], catalog, derive)
    expect(out.state.energy.current).toBe(2)
    expect(out.state.piles.hand.length).toBe(4)
    // 普攻 vs a 40-HP foe with no defense kills it → party victory.
    expect(out.state.combatants.find((c) => c.id === '哥布林')!.block.hp).toBe(0)
    expect(checkDuelVictory(out.state)).toBe('party')
  })
})

describe('endLeadTurn', () => {
  it('runs the enemy phase, refreshes energy, and draws a fresh hand', () => {
    const start = startDuel(built([lead(), foe(300)]), { seed: 7 })
    // spend some energy first
    const cardId = start.state.piles.hand[0]
    const mid = playCard(start.state, cardId, ['哥布林'], catalog, derive)
    const out = endLeadTurn(mid.state, catalog, derive)
    expect(out.state.energy.current).toBe(3)               // refreshed
    expect(out.state.piles.hand.length).toBe(5)            // redrawn
    expect(out.state.round).toBe(2)
    // the enemy acted on its telegraphed 横扫 → the lead took damage.
    expect(out.state.combatants.find((c) => c.id === '主角')!.block.hp).toBeLessThan(1000)
  })
})

describe('swapLeadIfDown', () => {
  it('promotes a living party member when the lead is down', () => {
    const s = startDuel(built([lead(), { ...lead(), id: '苏璃', name: '苏璃' }, foe()]), { seed: 7 }).state
    s.combatants.find((c) => c.id === '主角')!.block.hp = 0
    const out = swapLeadIfDown(s)
    expect(out.lead).toBe('苏璃')
  })
})
