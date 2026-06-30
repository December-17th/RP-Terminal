import { describe, it, expect } from 'vitest'
import type { DuelPreview } from '../../src/shared/combat/deckbuilder/preview'
import { buildDuelPreview } from '../../src/shared/combat/systems/poemPreview'
import type { StatMap, DeriveConfig } from '../../src/shared/combat/bundle'

describe('DuelPreview contract', () => {
  it('is structurally usable as the generic preview shape', () => {
    const p: DuelPreview = {
      config: { energyPerTurn: 3, handSize: 5 },
      lead: {
        id: '主角', name: '主角', tier: 2, level: 8,
        resources: { hp: 1820, maxHp: 2340, mp: 320, maxMp: 500, sp: 450, maxSp: 500 },
        modifiers: [{ key: 'attack', label: '攻击', value: 60 }],
        conditions: [{ id: '流血', label: '流血', stacks: 2, turns: 2, kind: 'debuff' }],
        deck: [{
          id: '主角/普攻', name: '普攻', rarityKey: 'common', rarityLabel: '普通',
          kind: 'attack', energyCost: 1, resourceCost: { sp: 5 },
          scalingAttr: '力量', power: 20, effectLines: [], ratingEstimate: 1.0, copies: 4
        }]
      },
      party: []
    }
    expect(p.lead.deck[0].copies).toBe(4)
    expect(p.config.energyPerTurn).toBe(3)
  })
})

describe('buildDuelPreview', () => {
  it('maps a poem build to the generic DuelPreview (deck with copies, resources, modifiers)', () => {
    const statMap: StatMap = { player: '主角', paths: { attributes: '属性', hp: '生命值', maxHp: '生命值上限', mp: '法力值', maxMp: '法力值上限', sp: '体力值', maxSp: '体力值上限', level: '等级', tier: '生命层级', equipment: '装备', skills: '技能', conditions: '状态效果' } }
    const derive: DeriveConfig = { attributes: ['力量','敏捷','体质','智力','精神'], tier_coefficient: { '2': 2.8 }, hp_multiplier: { '2': 2 }, mp_sp_multiplier: { '2': 2.5 }, rating_tiers: [[11,1.0],[0,0]], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }
    const statData = {
      主角: {
        生命层级: '第二层级', 等级: 8,
        属性: { 力量: 6, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 },
        生命值: 1820, 生命值上限: 2340, 法力值: 320, 法力值上限: 500, 体力值: 450, 体力值上限: 500,
        装备: { 长剑: { 类型: '武器', 品质: '优良', 标签: ['攻击: 60'], 效果: {} } },
        技能: { 烈焰斩: { 类型: '主动', 品质: '史诗', 消耗: '攻击: 30 MP', 标签: ['智力','威力: 140','有效距离: 1','范围: 锥形'], 效果: { 燃烧: '30+2回合' } } },
        状态效果: { 流血: { 类型: '减益', 剩余时间: '2回合' } }
      }
    }

    const p = buildDuelPreview(statData, statMap, { derive })
    expect(p.config).toEqual({ energyPerTurn: 3, handSize: 5 })
    expect(p.lead.name).toBe('主角')
    expect(p.lead.resources.maxHp).toBe(2340)
    // deck contains 普攻 ×4, 格挡 ×4, and the 史诗 烈焰斩 ×1
    const byName = (n: string) => p.lead.deck.find(c => c.name === n)
    expect(byName('普攻')?.copies).toBe(4)
    expect(byName('格挡')?.copies).toBe(4)
    const flame = byName('烈焰斩')!
    expect(flame.rarityKey).toBe('epic')
    expect(flame.rarityLabel).toBe('史诗')
    expect(flame.power).toBe(140)
    expect(flame.resourceCost).toEqual({ mp: 30 })
    expect(flame.kind).toBe('attack')
    // a relic modifier from the weapon 攻击
    expect(p.lead.modifiers.some(m => m.value === 60)).toBe(true)
    // the 流血 condition is carried
    expect(p.lead.conditions.some(c => c.id === '流血')).toBe(true)
  })
})
