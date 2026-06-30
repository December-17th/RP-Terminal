// src/main/services/duelService.ts
//
// Interactive STS duel — main-process service. Holds the active DuelState + ability catalog per chat
// (in-memory; a duel is ephemeral), and applies the pure deckbuilder engine transitions. Mirrors
// combatService's shape but simpler: endLeadTurn resolves the whole non-lead phase in one call, so
// there is no stepped enemy-turn driver. See docs/superpowers/specs/2026-06-30-native-duelview-design.md.

import { buildEncounterFromMvu, type DeriveConfig, type StatMap } from '../../shared/combat/bundle'
import { startDuel, playCard, endLeadTurn, type DuelState } from '../../shared/combat/deckbuilder'
import { poemD20System } from '../../shared/combat/systems'
import { getCharacter } from './characterService'
import { getRpExt } from '../types/character'
import { getAllFloors } from './floorService'
import type { AbilityDef, CombatEvent } from '../../shared/combat/types'

export interface DuelRecord {
  state: DuelState
  catalog: Record<string, AbilityDef>
  derive?: DeriveConfig
}

/** The renderer view-model: the live state + the card/ability catalog (to render cards). */
export interface DuelView {
  state: DuelState
  catalog: Record<string, AbilityDef>
}

/** The current floor's MVU `stat_data` (where the party's stats live), or null if none.
 *  Mirrors `getLatestStatData` in duelPreviewService. */
const getLatestStatData = (profileId: string, chatId: string): Record<string, unknown> | null => {
  const floors = getAllFloors(profileId, chatId)
  const vars = (floors[floors.length - 1]?.variables ?? {}) as Record<string, unknown>
  const sd = vars.stat_data as Record<string, unknown> | undefined
  return sd ?? null
}

// --- mock setup (inline; canonical stat_map/derive from docs/sdk/examples/poem-combat-bundle.json) ---

const MOCK_STAT_MAP: StatMap = {
  player: '主角',
  party: { from: '关系列表', filter: { 在场: true } },
  paths: {
    attributes: '属性', hp: '生命值', maxHp: '生命值上限', mp: '法力值', maxMp: '法力值上限',
    sp: '体力值', maxSp: '体力值上限', level: '等级', tier: '生命层级', equipment: '装备',
    skills: '技能', conditions: '状态效果'
  }
}

const MOCK_DERIVE: DeriveConfig = {
  attributes: ['力量', '敏捷', '体质', '智力', '精神'],
  tier_coefficient: { '1': 2, '2': 2.8, '3': 4, '4': 8, '5': 15, '6': 35, '7': 80 },
  hp_multiplier: { '1': 1, '2': 2, '3': 4, '4': 10, '5': 20, '6': 40, '7': 100 },
  mp_sp_multiplier: { '1': 1, '2': 2.5, '3': 6, '4': 15, '5': 35, '6': 80, '7': 160 },
  rating_tiers: [[30, 2], [25, 1.6], [20, 1.3], [11, 1], [8, 0.8], [4, 0.3], [0, 0]],
  attr_mitigation: { 物理: 0.0025, 能量: 0.004, 精神: 0.008, 真实: 0 },
  defense_constant: 2000
}

const MOCK_STAT_DATA = {
  主角: {
    属性: { 力量: 6, 敏捷: 5, 体质: 7, 智力: 3, 精神: 4 },
    生命值: 1400, 生命值上限: 1400, 法力值: 700, 法力值上限: 700, 体力值: 1100, 体力值上限: 1100,
    等级: 8, 生命层级: '第二层级/优良',
    装备: {
      主手: { 品质: '优良', 类型: '巨剑', 标签: ['攻击: 80'], 效果: { 命中: '+2' }, 描述: '' },
      护甲: { 品质: '优良', 类型: '板甲', 标签: ['防御: 60'], 效果: {}, 描述: '' }
    },
    技能: {
      火球术: {
        品质: '稀有', 类型: '主动', 消耗: '攻击: 200 MP',
        标签: ['智力', '范围: 爆发', '威力: 300', '有效距离: 6'], 效果: { 灼烧: '30+2回合' }, 描述: ''
      },
      横扫: {
        品质: '优良', 类型: '主动', 消耗: '攻击: 60 SP',
        标签: ['力量', '威力: 90', '群体'], 效果: {}, 描述: ''
      },
      连环箭: {
        品质: '优良', 类型: '主动', 消耗: '攻击: 50 SP',
        标签: ['敏捷', '威力: 40', '随机3'], 效果: {}, 描述: ''
      },
      治愈术: {
        品质: '优良', 类型: '主动', 消耗: '攻击: 120 MP',
        标签: ['精神', '威力: 200', '治疗'], 效果: {}, 描述: ''
      }
    },
    状态效果: {}
  },
  关系列表: {
    艾莉亚: {
      在场: true, 属性: { 力量: 4, 敏捷: 6, 体质: 5, 智力: 7, 精神: 6 },
      生命值: 1000, 生命值上限: 1000, 等级: 6, 生命层级: '第二层级/优良',
      装备: { 法杖: { 品质: '优良', 类型: '法杖', 标签: ['攻击: 50'], 效果: {}, 描述: '' } },
      技能: {}, 状态效果: {}
    }
  }
}

const MOCK_ROSTER = [
  {
    名称: '哥布林', 数量: 2, 生命层级: '第一层级', 等级: 3,
    属性: { 力量: 4, 敏捷: 3, 体质: 4, 智力: 1, 精神: 1 },
    装备: { 爪牙: { 类型: '天生武器', 标签: ['攻击: 25'], 效果: {} } }, 技能: {}, 状态效果: {}
  }
]

export const createMockDuel = (): DuelRecord => {
  const built = buildEncounterFromMvu(MOCK_STAT_DATA as Record<string, unknown>, MOCK_STAT_MAP, poemD20System, {
    derive: MOCK_DERIVE, seed: 7, roster: MOCK_ROSTER
  })
  const { state, catalog } = startDuel(built, { seed: 7 })
  return { state, catalog, derive: MOCK_DERIVE }
}

// --- pure orchestration over a record (unit-testable) ---

export const playCardIn = (
  rec: DuelRecord, cardId: string, targetIds: string[]
): { record: DuelRecord; events: CombatEvent[] } => {
  const { state, events } = playCard(rec.state, cardId, targetIds, rec.catalog, rec.derive)
  return { record: { ...rec, state }, events }
}

export const endTurnIn = (rec: DuelRecord): { record: DuelRecord; events: CombatEvent[] } => {
  const { state, events } = endLeadTurn(rec.state, rec.catalog, rec.derive)
  return { record: { ...rec, state }, events }
}

// --- chatId-keyed wrappers (in-memory; main process is long-lived) ---

const duels = new Map<string, DuelRecord>()
const view = (rec: DuelRecord): DuelView => ({ state: rec.state, catalog: rec.catalog })

export const getDuel = (chatId: string): DuelView | null => {
  const rec = duels.get(chatId)
  return rec ? view(rec) : null
}

export const startMockDuel = (chatId: string): DuelView => {
  const rec = createMockDuel()
  duels.set(chatId, rec)
  return view(rec)
}

export const playDuelCard = (
  chatId: string, cardId: string, targetIds: string[]
): { state: DuelState; events: CombatEvent[] } | null => {
  const rec = duels.get(chatId)
  if (!rec) return null
  const { record, events } = playCardIn(rec, cardId, targetIds)
  duels.set(chatId, record)
  return { state: record.state, events }
}

export const endDuelTurn = (chatId: string): { state: DuelState; events: CombatEvent[] } | null => {
  const rec = duels.get(chatId)
  if (!rec) return null
  const { record, events } = endTurnIn(rec)
  duels.set(chatId, record)
  return { state: record.state, events }
}

export const endDuel = (chatId: string): void => {
  duels.delete(chatId)
}

/** Start a duel from the active chat's current MVU build (player + 在场 party; AI roster TBD).
 *  Gathers stat_data + the card's combat bundle the same way duelPreviewService does.
 *  v1: builds an enemyless (party-only) encounter — needs an AI-supplied roster of enemies before
 *  it is usable; no UI invokes this yet. */
export const startDuelFromMvu = (
  profileId: string, chatId: string, characterId: string
): DuelView | null => {
  const statData = getLatestStatData(profileId, chatId)
  const character = getCharacter(profileId, characterId)
  const bundle = (character ? getRpExt(character)?.combat : null) as
    | { stat_map?: StatMap; derive?: DeriveConfig }
    | null
    | undefined
  if (!statData || !bundle?.stat_map) return null
  const built = buildEncounterFromMvu(statData, bundle.stat_map, poemD20System, { derive: bundle.derive, seed: 7 })
  const { state, catalog } = startDuel(built, { seed: 7 })
  const rec: DuelRecord = { state, catalog, derive: bundle.derive }
  duels.set(chatId, rec)
  return view(rec)
}
