import { describe, it, expect } from 'vitest'
import { chooseIntent, resolveIntent } from '../../../src/shared/combat/deckbuilder/intents'
import type { DuelState } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { AbilityDef, Combatant, CombatEvent } from '../../../src/shared/combat/types'
import type { Rng } from '../../../src/shared/combat/dice'

const fixedRoll = (n: number): Rng => () => (n - 0.5) / 20
const derive = { tier_coefficient: { '2': 2.8 }, rating_tiers: [[11, 1.0], [0, 0]] as [number, number][], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

const foe = (): Combatant => ({
  id: '哥布林', side: 'enemy', name: '哥布林', pos: [1, 0],
  block: { hp: 300, maxHp: 300, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['哥布林/横扫'] },
  ext: { system: 'poemD20', attrs: { 力量: 4, 体质: 4 }, tier: 2, equip: { 武器攻击: 30 } }
})
const lead = (): Combatant => ({
  id: '主角', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: [] },
  ext: { system: 'poemD20', attrs: { 体质: 6 }, tier: 2, equip: { 防御: 0 } }
})
const catalog: Record<string, AbilityDef> = {
  '哥布林/横扫': { id: '哥布林/横扫', name: '横扫', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 80, 关联属性: '力量' } }
}
const duel = (combatants: Combatant[]): DuelState => ({
  seed: 1, rngCursor: 0, combatants, lead: '主角',
  energy: { current: 3, max: 3 }, piles: { draw: [], hand: [], discard: [], exhaust: [] },
  cards: {}, intents: {}, phase: 'enemies', round: 1, status: 'active', log: [], handSize: 5
})

describe('chooseIntent', () => {
  it('telegraphs an attack on the first living opponent with a preview', () => {
    const intent = chooseIntent(duel([lead(), foe()]), '哥布林', catalog)
    expect(intent.kind).toBe('attack')
    expect(intent.abilityId).toBe('哥布林/横扫')
    expect(intent.target).toBe('主角')
    expect(intent.preview).toBeGreaterThan(0)
  })
})

describe('resolveIntent', () => {
  it('executes the telegraphed attack and damages the target', () => {
    const cs = [lead(), foe()]
    const intent = chooseIntent(duel(cs), '哥布林', catalog)
    const events: CombatEvent[] = []
    resolveIntent(cs, '哥布林', intent, fixedRoll(15), derive, catalog, events)
    expect(cs[0].block.hp).toBeLessThan(1000)
    expect(events.some((e) => e.kind === 'damage')).toBe(true)
  })
})
