import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildEncounterFromMvu,
  type CombatBundle,
  type StatMap,
  type DeriveConfig
} from '../../src/shared/combat/bundle'
import { poemD20System } from '../../src/shared/combat/systems/poemD20'
import { CombatBundleSchema } from '../../src/main/types/character'
import { createEncounter, playerAction, nextTurn } from '../../src/main/services/combatService'

// The deliverable bundle config the 命定之诗 card embeds — read so the test pins the real artifact.
const combat = JSON.parse(
  readFileSync('docs/sdk/examples/poem-combat-bundle.json', 'utf8')
) as CombatBundle
const statMap = combat.stat_map as StatMap
const derive = combat.derive as DeriveConfig

// A realistic 命定之诗 stat_data: 主角 + two companions (one present, one not).
const statData = {
  主角: {
    属性: { 力量: 6, 敏捷: 5, 体质: 7, 智力: 3, 精神: 4 },
    生命值: 1400,
    生命值上限: 1400,
    法力值: 700,
    法力值上限: 700,
    体力值: 1100,
    体力值上限: 1100,
    等级: 8,
    生命层级: '第二层级/优良',
    装备: {
      主手: { 品质: '优良', 类型: '巨剑', 标签: ['攻击: 80'], 效果: { 命中: '+2' }, 描述: '' },
      护甲: { 品质: '优良', 类型: '板甲', 标签: ['防御: 60'], 效果: {}, 描述: '' }
    },
    技能: {
      火球术: {
        品质: '稀有',
        类型: '主动',
        消耗: '攻击: 200 MP',
        标签: ['智力', '范围: 爆发', '威力: 300', '有效距离: 6'],
        效果: { 灼烧: '30+2回合' },
        描述: ''
      }
    },
    状态效果: {}
  },
  关系列表: {
    艾莉亚: {
      在场: true,
      属性: { 力量: 4, 敏捷: 6, 体质: 5, 智力: 7, 精神: 6 },
      生命值: 1000,
      生命值上限: 1000,
      等级: 6,
      生命层级: '第二层级/优良',
      装备: { 法杖: { 品质: '优良', 类型: '法杖', 标签: ['攻击: 50'], 效果: {}, 描述: '' } },
      技能: {},
      状态效果: {}
    },
    弗洛洛: {
      在场: false,
      属性: { 力量: 2, 敏捷: 3, 体质: 2, 智力: 9, 精神: 8 },
      生命值: 600,
      生命值上限: 600,
      等级: 5,
      生命层级: '第二层级',
      装备: {},
      技能: {},
      状态效果: {}
    }
  }
}

describe('命定之诗 combat integration (BP5)', () => {
  it('the example bundle config is valid + carries the expected stat_map/derive', () => {
    expect(() => CombatBundleSchema.parse(combat)).not.toThrow()
    expect(statMap.player).toBe('主角')
    expect(statMap.party).toEqual({ from: '关系列表', filter: { 在场: true } })
    expect(derive.tier_coefficient?.['2']).toBe(2.8)
    expect(derive.defense_constant).toBe(2000)
  })

  it('imports the party from stat_data (主角 + present companion; 在场:false filtered)', () => {
    const enc = buildEncounterFromMvu(statData, statMap, poemD20System, { derive })
    expect(enc.combatants.map((c) => c.id)).toEqual(['主角', '艾莉亚'])
    const hero = enc.combatants[0]
    expect(hero.block.maxHp).toBe(1400)
    expect((hero.ext as Record<string, any>).attrs.体质).toBe(7)
    expect((hero.ext as Record<string, any>).equip.武器攻击).toBe(80)
    // .sort() is by UTF-16 code unit: 普(U+666E) < 火(U+706B).
    expect(Object.keys(enc.abilities).sort()).toEqual(['主角/普攻', '主角/火球术', '艾莉亚/普攻'])
  })

  it('builds enemies from the cue against the bundle templates', () => {
    const enc = buildEncounterFromMvu(statData, statMap, poemD20System, {
      derive,
      enemies: combat.enemies,
      enemiesCue: '哥布林 x2; 头目'
    })
    expect(enc.combatants.filter((c) => c.side === 'enemy').map((c) => c.id)).toEqual([
      '哥布林-1',
      '哥布林-2',
      '头目'
    ])
    const boss = enc.combatants.find((c) => c.id === '头目')!
    expect(boss.block.maxHp).toBe(900)
    expect((boss.ext as Record<string, any>).equip.武器攻击).toBe(70)
    expect(enc.abilities['头目/横扫']).toBeTruthy()
    expect(enc.abilities['头目/横扫'].shape).toEqual({ kind: 'cone', len: 2 })
  })

  it('builds enemies from an AI-supplied roster (A1 cue payload)', () => {
    const roster = [
      {
        名称: '魔物',
        数量: 2,
        生命层级: '第一层级',
        等级: 3,
        属性: { 力量: 4, 敏捷: 3, 体质: 4, 智力: 1, 精神: 1 },
        装备: { 爪牙: { 类型: '天生武器', 标签: ['攻击: 25'], 效果: {} } },
        技能: {},
        状态效果: {}
      },
      {
        名称: '盟友',
        阵营: '友方',
        生命层级: '第二层级',
        属性: { 敏捷: 8 },
        装备: {},
        技能: {},
        状态效果: {}
      }
    ]
    const enc = buildEncounterFromMvu(statData, statMap, poemD20System, { derive, roster })
    // 2 拷贝 of 魔物 (enemy) + 1 盟友 routed to the party side.
    expect(enc.combatants.filter((c) => c.side === 'enemy').map((c) => c.id)).toEqual([
      '魔物-1',
      '魔物-2'
    ])
    expect(enc.combatants.some((c) => c.id === '盟友' && c.side === 'party')).toBe(true)
    expect(
      (enc.combatants.find((c) => c.id === '魔物-1')!.ext as Record<string, any>).equip.武器攻击
    ).toBe(25)
  })

  it('runs a full fight to a deterministic victory via the 战斗协议 resolver', async () => {
    // A tight grid so the cue-spawned enemies (right edge) sit adjacent to the party (left edge),
    // and the scripted "attack the nearest foe" loop can resolve without modelling movement.
    const built = buildEncounterFromMvu(statData, statMap, poemD20System, {
      derive,
      seed: 7,
      grid: { w: 2, h: 4, cellFt: 5 },
      enemies: combat.enemies,
      enemiesCue: '哥布林 x2; 头目'
    })

    let rec = createEncounter({
      seed: 7,
      grid: built.grid,
      combatants: built.combatants,
      abilities: built.abilities,
      system: 'poemD20',
      derive
    })

    let guard = 0
    let damageEvents = 0
    while (rec.state.status === 'active' && guard++ < 200) {
      const actorId = rec.state.initiative[rec.state.turnIndex]
      const actor = rec.state.combatants.find((c) => c.id === actorId)
      if (actor && actor.block.hp > 0) {
        const foeSide = actor.side === 'party' ? 'enemy' : 'party'
        const foe = rec.state.combatants.find((c) => c.side === foeSide && c.block.hp > 0)
        if (foe) {
          const res = await playerAction(rec, {
            kind: 'ability',
            actor: actorId,
            abilityId: `${actorId}/普攻`,
            targetIds: [foe.id],
            targetCell: foe.pos
          })
          rec = res.record
          damageEvents += res.events.filter((e) => e.kind === 'damage').length
        }
      }
      rec = nextTurn(rec)
    }

    expect(rec.state.status).toBe('party') // the party clears the goblins + 头目
    expect(
      rec.state.combatants.filter((c) => c.side === 'enemy').every((c) => c.block.hp === 0)
    ).toBe(true)
    expect(damageEvents).toBeGreaterThan(1) // a multi-strike, card-scale fight actually happened
  })
})
