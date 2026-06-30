import { describe, it, expect } from 'vitest'
import { resolvePlay, applyAbilityEffect } from '../../../src/shared/combat/deckbuilder/deckResolve'
import type { DuelState } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { AbilityDef, Combatant, CombatEvent } from '../../../src/shared/combat/types'
import type { Rng } from '../../../src/shared/combat/dice'

const fixedRoll = (n: number): Rng => () => (n - 0.5) / 20
const derive = { tier_coefficient: { '2': 2.8 }, rating_tiers: [[11, 1.0], [0, 0]] as [number, number][], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

const lead = (): Combatant => ({
  id: '主角', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: [] },
  ext: { system: 'poemD20', attrs: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, tier: 2, mp: 100, sp: 100, equip: { 武器攻击: 60, 防御: 0 }, shield: 0 }
})
const foe = (): Combatant => ({
  id: '哥布林', side: 'enemy', name: '哥布林', pos: [1, 0],
  block: { hp: 500, maxHp: 500, ac: 10, speed: 6, mods: {}, conditions: [], abilities: [] },
  ext: { system: 'poemD20', attrs: { 体质: 4 }, tier: 2, equip: { 防御: 0 } }
})
const strike: AbilityDef = { id: '主角/普攻', name: '普攻', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 20, 关联属性: '力量', 消耗: { slot: 'attack', sp: 5 } } }
const block: AbilityDef = { id: '主角/格挡', name: '格挡', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'action', ext: { 格挡: true, 护盾: 50 } }

const duel = (combatants: Combatant[], cards: DuelState['cards'], hand: string[]): DuelState => ({
  seed: 1, rngCursor: 0, combatants, lead: '主角',
  energy: { current: 3, max: 3 },
  piles: { draw: [], hand, discard: [], exhaust: [] },
  cards, intents: {}, phase: 'lead', round: 1, status: 'active', log: [], handSize: 5
})

describe('applyAbilityEffect', () => {
  it('格挡 grants 护盾 to the actor', () => {
    const cs = [lead(), foe()]
    const events: CombatEvent[] = []
    applyAbilityEffect(cs, '主角', block, [], fixedRoll(15), derive, events)
    expect((cs[0].ext as any).shield).toBe(50)
    expect((cs[0].ext as any).blockGained).toBe(50)
  })
})

describe('resolvePlay', () => {
  it('deducts energy + 消耗, deals damage, and discards the card', () => {
    const cards = { 'c1': { id: 'c1', abilityId: '主角/普攻', owner: '主角', energyCost: 1 } }
    const s = duel([lead(), foe()], cards, ['c1'])
    const out = resolvePlay(s, 'c1', ['哥布林'], fixedRoll(15), derive, { '主角/普攻': strike })
    expect(out.state.energy.current).toBe(2)              // 3 − 1
    expect((out.state.combatants[0].ext as any).sp).toBe(95) // 100 − 5
    expect(out.state.combatants[1].block.hp).toBeLessThan(500)
    expect(out.state.piles.hand).toEqual([])
    expect(out.state.piles.discard).toEqual(['c1'])
    expect(out.state.rngCursor).toBe(1)
  })

  it('an HP-cost card (血祭) spends the owner HP', () => {
    const bloody: AbilityDef = { id: '主角/血祭', name: '血祭', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 200, 关联属性: '力量', 消耗: { slot: 'attack', hp: 100 } } }
    const cards = { 'c1': { id: 'c1', abilityId: '主角/血祭', owner: '主角', energyCost: 1 } }
    const s = duel([lead(), foe()], cards, ['c1'])
    const out = resolvePlay(s, 'c1', ['哥布林'], fixedRoll(15), derive, { '主角/血祭': bloody })
    expect(out.state.combatants[0].block.hp).toBe(900)   // 1000 − 100 HP cost
  })
})
