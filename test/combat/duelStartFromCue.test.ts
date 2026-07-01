import { describe, it, expect } from 'vitest'
import { buildDuelRecord } from '../../src/main/services/duelService'
import type { StatMap, DeriveConfig } from '../../src/shared/combat/bundle'

const STAT_MAP: StatMap = {
  player: '主角',
  party: { from: '关系列表', filter: { 在场: true } },
  paths: {
    attributes: '属性', hp: '生命值', maxHp: '生命值上限', mp: '法力值', maxMp: '法力值上限',
    sp: '体力值', maxSp: '体力值上限', level: '等级', tier: '生命层级', equipment: '装备',
    skills: '技能', conditions: '状态效果'
  }
}
const DERIVE: DeriveConfig = {
  attributes: ['力量', '敏捷', '体质', '智力', '精神'],
  tier_coefficient: { '1': 2, '2': 2.8 },
  hp_multiplier: { '1': 1, '2': 2 },
  mp_sp_multiplier: { '1': 1, '2': 2.5 },
  rating_tiers: [[11, 1], [0, 0]],
  attr_mitigation: { 物理: 0.0025, 能量: 0.004, 精神: 0.008, 真实: 0 },
  defense_constant: 2000
}
const STAT_DATA = {
  主角: {
    属性: { 力量: 6, 敏捷: 5, 体质: 7, 智力: 3, 精神: 4 },
    生命值: 1400, 生命值上限: 1400, 法力值: 700, 法力值上限: 700, 体力值: 1100, 体力值上限: 1100,
    等级: 8, 生命层级: '第二层级/优良', 装备: {}, 技能: {}, 状态效果: {}
  },
  关系列表: {}
}
const ROSTER = [{
  名称: '哥布林', 数量: 2, 生命层级: '第一层级', 等级: 3,
  属性: { 力量: 4, 敏捷: 3, 体质: 4, 智力: 1, 精神: 1 },
  装备: { 爪牙: { 类型: '天生武器', 标签: ['攻击: 25'], 效果: {} } }, 技能: {}, 状态效果: {}
}]

describe('buildDuelRecord', () => {
  it('builds an active duel with enemies from the roster and a party from stat_data', () => {
    const rec = buildDuelRecord(STAT_DATA as Record<string, unknown>, STAT_MAP, DERIVE, ROSTER)
    expect(rec.state.status).toBe('active')
    expect(rec.state.combatants.some((c) => c.side === 'enemy' && c.block.hp > 0)).toBe(true)
    expect(rec.state.combatants.some((c) => c.side === 'party' && c.block.hp > 0)).toBe(true)
    expect(rec.state.piles.hand.length).toBe(rec.state.handSize)
  })
  it('with no roster builds a party-only (enemyless) encounter', () => {
    const rec = buildDuelRecord(STAT_DATA as Record<string, unknown>, STAT_MAP, DERIVE, undefined)
    expect(rec.state.combatants.some((c) => c.side === 'enemy')).toBe(false)
  })
})
