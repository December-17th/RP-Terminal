import { describe, it, expect } from 'vitest'
import {
  buildEncounterFromMvu,
  type DeriveConfig,
  type StatMap
} from '../../src/shared/combat/bundle'
import {
  parseCardItem,
  buildCombatant,
  tierNum,
  poemD20System
} from '../../src/shared/combat/systems/poemD20'
import type { MvuCharCtx } from '../../src/shared/combat/bundle'

const derive: DeriveConfig = {
  attributes: ['力量', '敏捷', '体质', '智力', '精神'],
  tier_coefficient: { '1': 2.0, '2': 2.8, '3': 4.0, '4': 8.0, '5': 15.0, '6': 35.0, '7': 80.0 },
  hp_multiplier: { '1': 1, '2': 2, '3': 4, '4': 10, '5': 20, '6': 40, '7': 100 },
  mp_sp_multiplier: { '1': 1, '2': 2.5, '3': 6, '4': 15, '5': 35, '6': 80, '7': 160 },
  rating_tiers: [
    [30, 2.0],
    [20, 1.3],
    [11, 1.0],
    [0, 0]
  ],
  attr_mitigation: { 物理: 0.0025, 能量: 0.004, 精神: 0.008, 真实: 0 },
  defense_constant: 2000
}

const paths = {
  attributes: '属性',
  hp: '生命值',
  maxHp: '生命值上限',
  mp: '法力值',
  maxMp: '法力值上限',
  sp: '体力值',
  maxSp: '体力值上限',
  level: '等级',
  tier: '生命层级',
  equipment: '装备',
  skills: '技能',
  conditions: '状态效果'
}

const statMap: StatMap = {
  player: '主角',
  party: { from: '关系列表', filter: { 在场: true } },
  paths
}

const statData = {
  主角: {
    属性: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 },
    生命值: 800,
    生命值上限: 800,
    法力值: 250,
    法力值上限: 250,
    体力值: 450,
    体力值上限: 450,
    等级: 8,
    生命层级: '第二层级/优良',
    装备: {
      主手: { 品质: '优良', 类型: '单手剑', 标签: ['攻击: 60'], 效果: { 命中: '+1' }, 描述: '' },
      护甲: { 品质: '优良', 类型: '板甲', 标签: ['防御: 50'], 效果: { 闪避: '+2' }, 描述: '' }
    },
    技能: {
      火球术: {
        品质: '稀有',
        类型: '主动',
        消耗: '攻击: 200 MP',
        标签: ['智力', '范围: 爆发', '威力: 300', '有效距离: 6'],
        效果: { 灼烧: '30+2回合' },
        描述: ''
      },
      铁壁: { 品质: '优良', 类型: '被动', 消耗: '', 标签: ['体质'], 效果: { DR: '10%' }, 描述: '' }
    },
    状态效果: { 祝福: { 类型: '增益', 效果: '命中+2', 层数: 1, 剩余时间: '3回合', 来源: '牧师' } }
  },
  关系列表: {
    艾莉亚: {
      在场: true,
      属性: { 力量: 3, 敏捷: 5, 体质: 4, 智力: 6, 精神: 5 },
      生命值: 400,
      生命值上限: 400,
      等级: 6,
      生命层级: '第二层级/优良',
      装备: {},
      技能: {},
      状态效果: {}
    },
    弗洛洛: {
      在场: false,
      属性: { 力量: 1, 敏捷: 2, 体质: 1, 智力: 8, 精神: 7 },
      生命值: 200,
      生命值上限: 200,
      等级: 5,
      生命层级: '第二层级',
      装备: {},
      技能: {},
      状态效果: {}
    }
  }
}

describe('parseCardItem', () => {
  it('parses a skill: 关联属性, 威力, 有效距离, shape, 消耗, 附加效果, 需视线', () => {
    const c = parseCardItem(statData.主角.技能.火球术, 'skill')
    expect(c.关联属性).toBe('智力')
    expect(c.威力).toBe(300)
    expect(c.range).toBe(6)
    expect(c.shape).toEqual({ kind: 'burst', r: 2 })
    expect(c.消耗).toEqual({ slot: 'attack', mp: 200 })
    expect(c.附加效果).toEqual([{ 状态: '灼烧', 数值: 30, 回合: 2 }])
    expect(c.需视线).toBe(true)
  })

  it('parses equipment 攻击/防御 and 检定 effects', () => {
    expect(parseCardItem(statData.主角.装备.主手, 'equip')).toMatchObject({ 攻击: 60, 命中: 1 })
    expect(parseCardItem(statData.主角.装备.护甲, 'equip')).toMatchObject({ 防御: 50, 闪避: 2 })
  })

  it('parses an 动作-slot skill and a DR passive', () => {
    const c = parseCardItem(
      {
        类型: '主动',
        消耗: '动作: 100 SP',
        标签: ['力量', '单体', '威力: 80'],
        效果: { DR: '5%', 穿透: '20%' }
      },
      'skill'
    )
    expect(c.消耗).toEqual({ slot: 'action', sp: 100 })
    expect(c.范围目标).toBe(1)
    expect(c.DR).toBe(5)
    expect(c.穿透).toBe(20)
    expect(parseCardItem(statData.主角.技能.铁壁, 'skill').DR).toBe(10)
  })

  it('tolerates junk / empty items', () => {
    expect(parseCardItem(null, 'skill')).toEqual({})
    expect(parseCardItem({ 标签: 'not-an-array', 效果: 5 }, 'skill')).toEqual({})
  })
})

describe('tierNum', () => {
  it('reads 生命层级 text, else derives from 等级', () => {
    expect(tierNum('第二层级/优良')).toBe(2)
    expect(tierNum('第七层级')).toBe(7)
    expect(tierNum('', 8)).toBe(2) // Lv 5-8 → tier 2
    expect(tierNum('', 25)).toBe(7)
    expect(tierNum(undefined, undefined)).toBe(1)
  })
})

describe('buildCombatant', () => {
  const ctx: MvuCharCtx = { id: '主角', name: '主角', side: 'party', paths, derive }

  it('reads attrs, resources, abilities (active only), gear, conditions into ext', () => {
    const built = buildCombatant(statData.主角, ctx)
    expect(built.block.hp).toBe(800)
    expect(built.block.maxHp).toBe(800)
    expect(built.block.conditions).toEqual([{ id: '祝福', duration: 3 }])
    // active skill + basic attack become abilities; passive does NOT.
    expect(built.abilities.map((a) => a.id)).toEqual(['主角/普攻', '主角/火球术'])
    const ext = built.ext as Record<string, any>
    expect(ext.attrs).toEqual({ 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 })
    expect(ext.tier).toBe(2)
    expect(ext.equip).toEqual({ 武器攻击: 60, 防御: 50, 命中: 1, 闪避: 2, DR: 0 })
    expect(ext.passives).toEqual([{ name: '铁壁', combat: expect.objectContaining({ DR: 10 }) }])
  })

  it('derives missing resources via the 资源推演 formula (fallback)', () => {
    const noMax = {
      属性: { 力量: 2, 敏捷: 2, 体质: 5, 智力: 4, 精神: 4 },
      生命值: 0,
      等级: 7,
      生命层级: '第二层级',
      装备: {},
      技能: {},
      状态效果: {}
    }
    const built = buildCombatant(noMax, ctx)
    // tier 2 → hp_mul 2: 体质5×100×2 + Σ(2+2+5+4+4=17) = 1017; mp_sp_mul 2.5
    expect(built.block.maxHp).toBe(1017)
    const ext = built.ext as Record<string, any>
    expect(ext.maxMp).toBe(Math.round((4 + 4) * 50 * 2.5)) // (智+精)×50×2.5 = 1000
    expect(ext.maxSp).toBe(Math.round((2 + 2) * 50 * 2.5)) // (力+敏)×50×2.5 = 500
  })
})

describe('buildEncounterFromMvu', () => {
  it('builds the player + present companions, filtering 在场:false', () => {
    const enc = buildEncounterFromMvu(statData, statMap, poemD20System, { derive })
    expect(enc.combatants.map((c) => c.id)).toEqual(['主角', '艾莉亚'])
    expect(enc.combatants.every((c) => c.side === 'party')).toBe(true)
    expect(enc.combatants[0].pos).toEqual([0, 0])
    expect(enc.combatants[1].pos).toEqual([0, 1])
  })

  it('catalogs each combatant’s abilities (namespaced, no passives)', () => {
    const enc = buildEncounterFromMvu(statData, statMap, poemD20System, { derive })
    expect(Object.keys(enc.abilities).sort()).toEqual(['主角/普攻', '主角/火球术', '艾莉亚/普攻'])
    const fb = enc.abilities['主角/火球术']
    expect(fb.range).toBe(6)
    expect(fb.cost).toBe('attack')
    expect(fb.shape).toEqual({ kind: 'burst', r: 2 })
    expect(fb.toHit).toBeNull()
    const ext = fb.ext as Record<string, any>
    expect(ext.威力).toBe(300)
    expect(ext.关联属性).toBe('智力')
  })
})
