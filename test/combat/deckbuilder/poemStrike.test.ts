import { describe, it, expect } from 'vitest'
import { poemHitOne, ATTRS } from '../../../src/shared/combat/systems/poemStrike'
import type { CardCombat } from '../../../src/shared/combat/systems/poemStrike'
import type { AbilityDef, Combatant, CombatEvent } from '../../../src/shared/combat/types'
import type { Rng } from '../../../src/shared/combat/dice'

const fixedRoll = (n: number): Rng => () => (n - 0.5) / 20

const actor = (): Combatant => ({
  id: 'A', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 800, maxHp: 800, ac: 10, speed: 6, mods: { DEX: 4 }, abilities: [], conditions: [] },
  ext: { system: 'poemD20', attrs: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, tier: 2, equip: { 武器攻击: 60, 防御: 50, 命中: 1, 闪避: 2, DR: 0 }, passives: [] }
})
const target = (): Combatant => ({
  id: 'B', side: 'enemy', name: '哥布林', pos: [1, 0],
  block: { hp: 500, maxHp: 500, ac: 10, speed: 6, mods: {}, abilities: [], conditions: [] },
  ext: { system: 'poemD20', attrs: { 力量: 3, 敏捷: 5, 体质: 4, 智力: 1, 精神: 2 }, tier: 2, equip: { 武器攻击: 0, 防御: 100, 命中: 0, 闪避: 3, DR: 10 }, passives: [] }
})
const fireball: AbilityDef = {
  id: 'A/火球术', name: '火球术', range: 6, shape: { kind: 'self' }, toHit: null, cost: 'attack',
  ext: { 关联属性: '智力', 威力: 300 } as CardCombat as Record<string, unknown>
}
const derive = { tier_coefficient: { '2': 2.8 }, rating_tiers: [[30, 2.0], [25, 1.6], [20, 1.3], [11, 1.0], [8, 0.8], [4, 0.3], [0, 0]] as [number, number][], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

describe('poemStrike.poemHitOne (extracted)', () => {
  it('exports ATTRS in canonical order', () => {
    expect([...ATTRS]).toEqual(['力量', '敏捷', '体质', '智力', '精神'])
  })

  it('有效 (评级 ×1.0) deals damage and lowers HP', () => {
    const a = actor(), b = target()
    const events: CombatEvent[] = []
    poemHitOne(a, b, fireball, fixedRoll(15), derive, events)
    expect(b.block.hp).toBe(155)
    expect(events.find((e) => e.kind === 'damage')?.delta).toMatchObject({ damage: 345, rating: 1.0 })
  })
})
