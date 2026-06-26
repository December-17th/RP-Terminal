// 命定之诗 combat system adapter (BP2: parse + buildCombatant; BP3 adds the resolver).
//
// Pure module. Interprets the 命定之诗 card's OWN stat grammar — the AI authors combat numbers
// into the MVU-preserved fields 标签 / 效果 / 消耗 (per the card's worldbook
// [技能装备道具生成规则] / [品质效果限定] / [角色生成] / [战斗协议]). The card's data_schema
// whitelists those fields, so a free-floating 战斗 sub-object would be deleted — we parse what
// the card already writes. See docs/combat-poem-of-destiny-expansion.md.
//
// Heuristic by design: the grammar is whatever the AI emits, so parsing is tolerant and pinned
// by tests rather than a strict format.

import type { AoeShape, Condition, StatBlock } from '../types'
import type { BuiltCombatant, CombatSystem, ItemKind, MvuCharCtx } from '../bundle'

/** The five attributes, in canonical order (also `derive.attributes`). */
export const ATTRS = ['力量', '敏捷', '体质', '智力', '精神'] as const
export type Attr = (typeof ATTRS)[number]

/** Normalized combat numbers parsed off one 技能/装备, carried on `AbilityDef.ext` / combatant ext. */
export interface CardCombat {
  品质?: string
  类型?: string
  /** scaling + 检定 attribute (one of the five), from a bare 标签 entry. */
  关联属性?: Attr
  /** 技能威力 (skill power) — `威力: X` tag, else a 品质 fallback. */
  威力?: number
  /** equipment single-piece 攻击 / 防御. */
  攻击?: number
  防御?: number
  /** action-economy slot + resource cost, from 消耗. */
  消耗?: { slot: 'attack' | 'action'; mp?: number; sp?: number }
  /** 有效距离 in cells. */
  range?: number
  shape?: AoeShape
  /** 范围:X target count (multi-single-target), distinct from a geometric AoE. */
  范围目标?: number
  /** 检定 modifiers parsed off 效果 (multi-source = max). */
  命中?: number
  闪避?: number
  先攻?: number
  抵抗?: number
  /** 固伤 (额外固定伤害), DR%, 穿透%, 暴击倍率, from 效果. */
  额外固定伤害?: number
  DR?: number
  穿透?: number
  暴击倍率?: number
  /** 附加效果: status-on-hit `状态名: 数值+回合`. */
  附加效果?: { 状态: string; 数值?: number; 回合: number }[]
  /** multi-hit N (多段/连击). */
  多段?: number
  需视线?: boolean
}

// --- coercion helpers (MVU data is loose) ---
const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown, d = 0): number => {
  if (typeof v === 'number') return v
  const m = str(v).match(/-?\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : d
}
const pct = (v: unknown): number => {
  const m = str(v).match(/(\d+(\.\d+)?)\s*%/)
  return m ? parseFloat(m[1]) : num(v)
}

/** 生命层级 string ("第二层级/优良") or 等级 → tier number 1–7 (核心数值表: 一层=Lv1-4 … 七层=Lv25). */
export const tierNum = (生命层级?: unknown, 等级?: unknown): number => {
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 }
  const m = str(生命层级).match(/[一二三四五六七]/)
  if (m) return cn[m[0]]
  const lv = num(等级, 0)
  if (lv > 0) return Math.min(7, Math.max(1, Math.ceil(lv / 4)))
  return 1
}

const parseShape = (tag: string, range: number): { shape: AoeShape; 范围目标?: number } => {
  if (/爆发/.test(tag)) {
    const r = tag.match(/半径[:：]?\s*(\d+)/)
    return { shape: { kind: 'burst', r: r ? parseInt(r[1], 10) : 2 } }
  }
  if (/直线/.test(tag)) return { shape: { kind: 'line', len: Math.max(1, range) } }
  if (/锥形/.test(tag)) return { shape: { kind: 'cone', len: Math.max(1, range) } }
  // 范围:X = pick X targets (not a geometric area); 单体 = 1; 自身/环境 → self template.
  const x = tag.match(/范围[:：]?\s*(\d+)/)
  if (x) return { shape: { kind: 'self' }, 范围目标: parseInt(x[1], 10) }
  if (/单体/.test(tag)) return { shape: { kind: 'self' }, 范围目标: 1 }
  return { shape: { kind: 'self' } }
}

/**
 * Parse one 技能/装备 MVU object into normalized combat numbers. Reads the card's own grammar:
 * 标签 (关联属性 / 有效距离:X / 威力:X / 攻击·防御:N / 范围·爆发·直线·锥形·单体 / 多段·连击),
 * 消耗 (攻击|动作: X MP/SP), 效果 (命中/闪避/先攻/抵抗, 固伤, DR/穿透/暴击倍率, 附加效果 数值+回合).
 */
export const parseCardItem = (item: unknown, _kind: ItemKind): CardCombat => {
  const it = asRec(item)
  const out: CardCombat = {}
  if (str(it.品质)) out.品质 = str(it.品质)
  if (str(it.类型)) out.类型 = str(it.类型)

  for (const raw of asArr(it.标签)) {
    const t = str(raw).trim()
    if (!t) continue
    if ((ATTRS as readonly string[]).includes(t)) {
      out.关联属性 = t as Attr
      continue
    }
    let m: RegExpMatchArray | null
    if ((m = t.match(/有效距离[:：]?\s*(\d+)/))) out.range = parseInt(m[1], 10)
    else if ((m = t.match(/威力[:：]?\s*(\d+)/))) out.威力 = parseInt(m[1], 10)
    else if ((m = t.match(/攻击[:：]?\s*(\d+)/))) out.攻击 = parseInt(m[1], 10)
    else if ((m = t.match(/防御[:：]?\s*(\d+)/))) out.防御 = parseInt(m[1], 10)
    else if (/范围|爆发|直线|锥形|单体|自身|环境/.test(t)) {
      const s = parseShape(t, out.range ?? 1)
      out.shape = s.shape
      if (s.范围目标 != null) out.范围目标 = s.范围目标
    } else if (/多段|连击/.test(t)) {
      const n = t.match(/(\d+)/)
      out.多段 = n ? parseInt(n[1], 10) : 2
    } else if (!out.关联属性) {
      const a = ATTRS.find((x) => t.includes(x))
      if (a) out.关联属性 = a
    }
  }

  const cost = str(it.消耗)
  if (cost) {
    const slot: 'attack' | 'action' = /动作/.test(cost) ? 'action' : 'attack'
    const mp = cost.match(/(\d+)\s*MP/i)
    const sp = cost.match(/(\d+)\s*SP/i)
    out.消耗 = {
      slot,
      ...(mp ? { mp: parseInt(mp[1], 10) } : {}),
      ...(sp ? { sp: parseInt(sp[1], 10) } : {})
    }
  }

  for (const [k, vRaw] of Object.entries(asRec(it.效果))) {
    const v = str(vRaw)
    if (/命中/.test(k)) out.命中 = Math.max(out.命中 ?? 0, num(v))
    else if (/闪避/.test(k)) out.闪避 = Math.max(out.闪避 ?? 0, num(v))
    else if (/先攻/.test(k)) out.先攻 = Math.max(out.先攻 ?? 0, num(v))
    else if (/抵抗/.test(k)) out.抵抗 = Math.max(out.抵抗 ?? 0, num(v))
    else if (/固伤|额外固定/.test(k)) out.额外固定伤害 = (out.额外固定伤害 ?? 0) + num(v)
    else if (/^DR$|减伤/.test(k)) out.DR = Math.max(out.DR ?? 0, pct(v))
    else if (/穿透/.test(k)) out.穿透 = Math.max(out.穿透 ?? 0, pct(v))
    else if (/暴击倍率/.test(k)) out.暴击倍率 = num(v)
    else {
      const st = v.match(/(\d+)\s*\+\s*(\d+)\s*回合/) || v.match(/(\d+)\s*回合/)
      if (st) {
        out.附加效果 ??= []
        if (st.length === 3)
          out.附加效果.push({ 状态: k, 数值: parseInt(st[1], 10), 回合: parseInt(st[2], 10) })
        else out.附加效果.push({ 状态: k, 回合: parseInt(st[1], 10) })
      }
    }
  }

  // Ranged abilities (beyond melee) require line of sight by default.
  if ((out.range ?? 1) > 1) out.需视线 = true
  return out
}

const get = (
  char: Record<string, unknown>,
  paths: Record<string, string>,
  key: string
): unknown => {
  const p = paths[key]
  return p ? char[p] : undefined
}

/** Parse a 剩余时间 string ("3回合") into a round count; "" / none → -1 (until removed). */
const conditionFrom = (name: string, body: unknown): Condition => {
  const m = str(asRec(body).剩余时间).match(/(\d+)/)
  return { id: name, duration: m ? parseInt(m[1], 10) : -1 }
}

/**
 * Build a 命定之诗 combatant from a stat_data character. Reads the five attributes, resources
 * (direct from MVU; `资源推演` formula only as a fallback when 上限 is missing), parses 技能
 * (active → abilities, passive → ext.passives), aggregates 装备 攻击/防御/检定, and turns 状态效果
 * into conditions. The five attributes + parsed kit ride in `ext` for the resolver (BP3).
 */
export const buildCombatant = (char: unknown, ctx: MvuCharCtx): BuiltCombatant => {
  const c = asRec(char)
  const paths = ctx.paths
  const derive = ctx.derive ?? {}

  const attrSrc = asRec(get(c, paths, 'attributes'))
  const attrs: Record<Attr, number> = {
    力量: num(attrSrc.力量),
    敏捷: num(attrSrc.敏捷),
    体质: num(attrSrc.体质),
    智力: num(attrSrc.智力),
    精神: num(attrSrc.精神)
  }
  const sumAttrs = ATTRS.reduce((s, a) => s + attrs[a], 0)
  const tier = tierNum(get(c, paths, 'tier'), get(c, paths, 'level'))
  const hpMul = derive.hp_multiplier?.[String(tier)] ?? 1
  const resMul = derive.mp_sp_multiplier?.[String(tier)] ?? 1

  const hp = num(get(c, paths, 'hp'))
  const maxHp = num(get(c, paths, 'maxHp')) || Math.round(attrs.体质 * 100 * hpMul + sumAttrs)
  const maxMp = num(get(c, paths, 'maxMp')) || Math.round((attrs.智力 + attrs.精神) * 50 * resMul)
  const maxSp = num(get(c, paths, 'maxSp')) || Math.round((attrs.力量 + attrs.敏捷) * 50 * resMul)
  const mp = num(get(c, paths, 'mp')) || maxMp
  const sp = num(get(c, paths, 'sp')) || maxSp

  const abilities: BuiltCombatant['abilities'] = []
  const abilityIds: string[] = []
  const passives: { name: string; combat: CardCombat }[] = []

  for (const [name, skill] of Object.entries(asRec(get(c, paths, 'skills')))) {
    const combat = parseCardItem(skill, 'skill')
    if (combat.类型 === '被动') {
      passives.push({ name, combat })
      continue
    }
    const id = `${ctx.id}/${name}`
    abilityIds.push(id)
    abilities.push({
      id,
      name,
      range: combat.range ?? 1,
      shape: combat.shape ?? { kind: 'self' },
      toHit: null, // the card resolver rolls 命中−闪避→评级; no native attack roll.
      cost: combat.消耗?.slot ?? 'attack',
      requiresLoS: combat.需视线,
      ext: combat as unknown as Record<string, unknown>
    })
  }

  // Aggregate equipped gear: weapon 攻击 (max), armor 防御 (sum), 命中/闪避 (max).
  let 武器攻击 = 0
  let 防御 = 0
  let 命中 = 0
  let 闪避 = 0
  const equip: { slot: string; combat: CardCombat }[] = []
  for (const [slot, gear] of Object.entries(asRec(get(c, paths, 'equipment')))) {
    const combat = parseCardItem(gear, 'equip')
    equip.push({ slot, combat })
    if (combat.攻击) 武器攻击 = Math.max(武器攻击, combat.攻击)
    if (combat.防御) 防御 += combat.防御
    if (combat.命中) 命中 = Math.max(命中, combat.命中)
    if (combat.闪避) 闪避 = Math.max(闪避, combat.闪避)
  }

  // A basic attack (普攻威力 20) every combatant always has.
  const 普攻Id = `${ctx.id}/普攻`
  abilityIds.unshift(普攻Id)
  abilities.unshift({
    id: 普攻Id,
    name: '普攻',
    range: 1,
    shape: { kind: 'self' },
    toHit: null,
    cost: 'attack',
    ext: { 威力: 20, 关联属性: '力量', 武器攻击 } as Record<string, unknown>
  })

  const conditions: Condition[] = Object.entries(asRec(get(c, paths, 'conditions'))).map(([n, b]) =>
    conditionFrom(n, b)
  )

  const block: StatBlock = {
    hp: hp || maxHp,
    maxHp,
    ac: 10, // unused by the card resolver (命中−闪避 model); kept harmless for the native engine.
    speed: 6,
    mods: {}, // the five attributes ride in ext, not the native D&D mods.
    abilities: abilityIds,
    conditions
  }

  const ext: Record<string, unknown> = {
    system: 'poemD20',
    attrs,
    tier,
    level: num(get(c, paths, 'level')),
    mp,
    maxMp,
    sp,
    maxSp,
    equip: { 武器攻击, 防御, 命中, 闪避 },
    passives
  }

  return { block, ext, abilities }
}

/** The 命定之诗 combat system adapter (resolver added in BP3). The seam's `parseItem` returns an
 *  opaque bag; `parseCardItem` itself stays strongly typed for direct callers. */
export const poemD20System: CombatSystem = {
  parseItem: (item, kind) => parseCardItem(item, kind) as unknown as Record<string, unknown>,
  buildCombatant
}
