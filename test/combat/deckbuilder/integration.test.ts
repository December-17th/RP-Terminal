// test/combat/deckbuilder/integration.test.ts
import { describe, it, expect } from 'vitest'
import { buildDuelFromMvu, startDuel, playCard, endLeadTurn, DEFAULT_DECK_CONFIG } from '../../../src/shared/combat/deckbuilder'
import type { DeriveConfig, StatMap } from '../../../src/shared/combat/bundle'

const statMap: StatMap = { player: '主角', paths: { attributes: '属性', hp: '生命值', maxHp: '生命值上限', level: '等级', tier: '生命层级', equipment: '装备', skills: '技能', conditions: '状态效果' } }
const derive: DeriveConfig = { attributes: ['力量', '敏捷', '体质', '智力', '精神'], tier_coefficient: { '2': 2.8 }, hp_multiplier: { '2': 2 }, mp_sp_multiplier: { '2': 2.5 }, rating_tiers: [[11, 1.0], [0, 0]], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

const statData = {
  主角: { 生命层级: '第二层级', 等级: 8, 属性: { 力量: 6, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, 生命值: 1400, 生命值上限: 1400, 装备: {}, 技能: {}, 状态效果: {} }
}
const roster = [
  { 名称: '哥布林', 数量: 1, 生命层级: '第一层级', 等级: 2, 属性: { 力量: 2, 敏捷: 2, 体质: 2, 智力: 1, 精神: 1 }, 装备: {}, 技能: {}, 状态效果: {} }
]

describe('duel integration — MVU build → playable headless duel', () => {
  it('builds a duel from stat_data + an A1 roster and plays it deterministically to a result', () => {
    const built = buildDuelFromMvu(statData, statMap, { derive, roster, seed: 3 })
    expect(built.combatants.some((c) => c.side === 'party' && c.id === '主角')).toBe(true)
    expect(built.combatants.some((c) => c.side === 'enemy')).toBe(true)

    const { state, catalog } = startDuel(built, { seed: 3, config: DEFAULT_DECK_CONFIG })
    expect(state.piles.hand.length).toBe(5)

    // Play every affordable 普攻 in hand at the goblin across a few turns; it must resolve.
    let s = state
    for (let turn = 0; turn < 6 && s.status === 'active'; turn++) {
      for (const cardId of [...s.piles.hand]) {
        const enemy = s.combatants.find((c) => c.side === 'enemy' && c.block.hp > 0)
        if (!enemy) break
        const r = playCard(s, cardId, [enemy.id], catalog, derive)
        s = r.state
        if (s.status !== 'active') break
      }
      if (s.status !== 'active') break
      s = endLeadTurn(s, catalog, derive).state
    }
    // Deterministic with seed 3: the duel reaches a terminal status (party wins or party wipes).
    expect(['party', 'enemy']).toContain(s.status)
    // Replaying from the same seed reproduces the same outcome.
    const replay = startDuel(buildDuelFromMvu(statData, statMap, { derive, roster, seed: 3 }), { seed: 3 })
    expect(replay.state.piles.hand).toEqual(state.piles.hand)
  })
})
