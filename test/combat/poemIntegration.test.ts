import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildEncounterFromMvu,
  type CombatBundle,
  type StatMap,
  type DeriveConfig
} from '../../src/shared/combat/bundle'
import { poemD20System, buildCombatant } from '../../src/shared/combat/systems/poemD20'
import { CombatBundleSchema } from '../../src/main/types/character'
import { createEncounter, playerAction, nextTurn } from '../../src/main/services/combatService'
import type { Combatant } from '../../src/shared/combat/types'

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

// An AI-generated enemy (the deferred char_info→combatant entry step, simulated here).
const enemyChar = {
  属性: { 力量: 5, 敏捷: 3, 体质: 6, 智力: 1, 精神: 2 },
  生命值: 900,
  生命值上限: 900,
  等级: 7,
  生命层级: '第二层级',
  装备: { 利爪: { 品质: '优良', 类型: '天生武器', 标签: ['攻击: 40'], 效果: {}, 描述: '' } },
  技能: {},
  状态效果: {}
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

  it('runs a full fight to a deterministic victory via the 战斗协议 resolver', async () => {
    const built = buildEncounterFromMvu(statData, statMap, poemD20System, { derive, seed: 7 })
    const enemyBuilt = buildCombatant(enemyChar, {
      id: '魔物',
      name: '魔物',
      side: 'enemy',
      paths: statMap.paths!,
      derive
    })
    const enemy: Combatant = {
      id: '魔物',
      side: 'enemy',
      name: '魔物',
      pos: [1, 0],
      block: enemyBuilt.block,
      ext: enemyBuilt.ext
    }
    const abilities = { ...built.abilities }
    for (const a of enemyBuilt.abilities) abilities[a.id] = a

    let rec = createEncounter({
      seed: 7,
      grid: built.grid,
      combatants: [...built.combatants, enemy],
      abilities,
      system: 'poemD20',
      derive
    })

    let guard = 0
    let damageEvents = 0
    while (rec.state.status === 'active' && guard++ < 100) {
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

    expect(rec.state.status).toBe('party') // the party wins this matchup
    expect(rec.state.combatants.find((c) => c.id === '魔物')!.block.hp).toBe(0)
    expect(damageEvents).toBeGreaterThan(1) // a multi-strike, card-scale fight actually happened
  })
})
