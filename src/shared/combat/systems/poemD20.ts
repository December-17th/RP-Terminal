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

import { clone } from '../../objectPath'
import {
  ATTRS,
  poemHitOne,
  poemHealOne,
  type Attr,
  type CardCombat,
  type CombatantExt
} from './poemStrike'
import {
  clipToGrid,
  distance,
  lineOfSight,
  octantDir,
  targetsInCells,
  templateCells
} from '../grid'
import { isAlive } from '../resolver'
import type { AoeShape, Combatant, CombatEvent, Condition, StatBlock } from '../types'
import type {
  BuiltCombatant,
  CombatSystem,
  ItemKind,
  MvuCharCtx,
  ResolverContext
} from '../bundle'
import type { HookResult } from '../hooks'

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
 * Scan a flavor-keyed effect's VALUE prose for mechanics the card hides there (the real catalog format,
 * verified against FrontEnd-for-destined-journey/public/assets/data): e.g. `充能: 提高12%伤害`,
 * `凝护: 每次攻击获得50点护盾`, `锋锐: 额外造成5点物理伤害`. Accumulates onto `out` (best-effort).
 */
const scanEffectProse = (v: string, out: CardCombat): void => {
  let m: RegExpMatchArray | null
  if ((m = v.match(/(?:提高|增加|提升)\s*(\d+(?:\.\d+)?)\s*%\s*治疗/)))
    out.治疗增幅 = (out.治疗增幅 ?? 0) + parseFloat(m[1])
  else if ((m = v.match(/(?:提高|增加|提升)\s*(\d+(?:\.\d+)?)\s*%\s*(?:伤害|攻击)/)))
    out.伤害增幅 = (out.伤害增幅 ?? 0) + parseFloat(m[1])
  // damage reduction: a 减伤/减少/降低-伤害 phrase (either order) + a %.
  if (
    /减伤|(?:减少|降低|减免)[^。]*伤害|伤害[^。]*(?:减少|降低|减免)/.test(v) &&
    (m = v.match(/(\d+(?:\.\d+)?)\s*%/))
  )
    out.DR = Math.max(out.DR ?? 0, parseFloat(m[1]))
  if ((m = v.match(/(\d+)\s*点?\s*护盾/)) || (m = v.match(/护盾\s*(\d+)/)))
    out.护盾 = (out.护盾 ?? 0) + parseInt(m[1], 10)
  if ((m = v.match(/额外(?:造成|附加)?\s*(\d+)\s*点[^，。]*?伤害/)))
    out.额外固定伤害 = (out.额外固定伤害 ?? 0) + parseInt(m[1], 10)
  if (/穿透/.test(v) && (m = v.match(/(\d+(?:\.\d+)?)\s*%/)))
    out.穿透 = Math.max(out.穿透 ?? 0, parseFloat(m[1]))
  if ((m = v.match(/(?:恢复|治疗)\s*(?:HP\s*)?(\d+)\s*点?/)))
    out.治疗量 = (out.治疗量 ?? 0) + parseInt(m[1], 10)
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
    else if (/^(?:群体|群|全体|AOE)$/i.test(t)) {
      out.目标模式 = '群体'
    } else if ((m = t.match(/^随机[:：]?\s*(\d+)?/))) {
      out.目标模式 = '随机'
      out.随机次数 = m[1] ? parseInt(m[1], 10) : 1
    } else if (/范围|爆发|直线|锥形|单体|自身|环境/.test(t)) {
      const s = parseShape(t, out.range ?? 1)
      out.shape = s.shape
      if (s.范围目标 != null) out.范围目标 = s.范围目标
    } else if (/多段|连击/.test(t)) {
      const n = t.match(/(\d+)/)
      out.多段 = n ? parseInt(n[1], 10) : 2
    } else if (/治疗/.test(t)) {
      out.治疗 = true // 核心功能: 治疗 → a healing ability (威力 is the heal power)
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
    else if (/伤害增幅|增伤/.test(k)) out.伤害增幅 = (out.伤害增幅 ?? 0) + pct(v)
    else if (/护盾/.test(k)) out.护盾 = (out.护盾 ?? 0) + num(v)
    else if (/治疗增幅/.test(k)) out.治疗增幅 = (out.治疗增幅 ?? 0) + pct(v)
    else if (/治疗|恢复/.test(k)) out.治疗量 = (out.治疗量 ?? 0) + num(v)
    else {
      // Flavor-keyed effect (e.g. 充能/凝护/锋锐): the mechanic is in the VALUE prose, not the key —
      // a status (数值+回合) or a scanned mechanic (提高X%伤害 / X点护盾 / 额外X点伤害 / …).
      const st = v.match(/(\d+)\s*\+\s*(\d+)\s*回合/) || v.match(/(\d+)\s*回合/)
      if (st) {
        out.附加效果 ??= []
        if (st.length === 3)
          out.附加效果.push({ 状态: k, 数值: parseInt(st[1], 10), 回合: parseInt(st[2], 10) })
        else out.附加效果.push({ 状态: k, 回合: parseInt(st[1], 10) })
      } else scanEffectProse(v, out)
    }
  }

  // cone/line length follows 有效距离, independent of where the 范围 tag sat relative to it.
  if ((out.shape?.kind === 'cone' || out.shape?.kind === 'line') && out.range)
    out.shape = { ...out.shape, len: out.range }

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

  // Aggregate equipped gear + passives: weapon 攻击 (max), armor 防御 (sum), 命中/闪避/DR (max),
  // 伤害增幅 + 护盾 (sum). Passives contribute the same defensive/offensive mods as gear.
  let 武器攻击 = 0
  let 防御 = 0
  let 命中 = 0
  let 闪避 = 0
  let DR = 0
  let 伤害增幅 = 0
  let 护盾 = 0
  let 治疗增幅 = 0
  const equip: { slot: string; combat: CardCombat }[] = []
  const foldMods = (combat: CardCombat): void => {
    if (combat.命中) 命中 = Math.max(命中, combat.命中)
    if (combat.闪避) 闪避 = Math.max(闪避, combat.闪避)
    if (combat.DR) DR = Math.max(DR, combat.DR)
    if (combat.伤害增幅) 伤害增幅 += combat.伤害增幅
    if (combat.护盾) 护盾 += combat.护盾
    if (combat.治疗增幅) 治疗增幅 += combat.治疗增幅
  }
  for (const [slot, gear] of Object.entries(asRec(get(c, paths, 'equipment')))) {
    const combat = parseCardItem(gear, 'equip')
    equip.push({ slot, combat })
    if (combat.攻击) 武器攻击 = Math.max(武器攻击, combat.攻击)
    if (combat.防御) 防御 += combat.防御
    foldMods(combat)
  }
  for (const p of passives) foldMods(p.combat)

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
    // Bridge 敏捷 into the native DEX mod so the engine's rollInitiative gives the card's
    // 行动顺序 (敏捷 + d20). The five attributes themselves live in ext for the resolver.
    mods: { DEX: attrs.敏捷 },
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
    equip: { 武器攻击, 防御, 命中, 闪避, DR },
    伤害增幅, // outgoing damage ×(1+%) from gear/passives
    治疗增幅, // outgoing healing ×(1+%) from gear/passives
    shield: 护盾, // a mutable damage-absorbing pool (depleted before HP)
    passives
  }

  return { block, ext, abilities }
}

// --- BP3: the <战斗协议> resolver (deterministic; the AI only narrates/adjudicates) ---

/**
 * Resolve one action via the 命定之诗 战斗协议. Returns `null` for actions the native engine should
 * handle (move / end / improvise, or an attack that can't fire — out of range / no LoS / no such
 * ability — so the engine reports it without consuming budget). For a firing ability it deducts the
 * MP/SP 消耗 once, collects targets (explicit ids or the AoE template, capped by 范围:X), and resolves
 * each strike. Mutates a clone of `state`; the engine appends the events + consumes the action slot.
 */
export const poemResolveAction = (ctx: ResolverContext): HookResult | null => {
  const { action, abilities, rng, derive } = ctx
  if (action.kind !== 'ability') return null
  const state = clone(ctx.state)
  const actor = state.combatants.find((c) => c.id === action.actor)
  const ability = action.abilityId ? abilities[action.abilityId] : undefined
  if (!actor || !ability) return null

  const origin = action.targetCell ?? actor.pos
  if (distance(actor.pos, origin) > ability.range) return null
  if (ability.requiresLoS && !lineOfSight(state.grid, actor.pos, origin)) return null

  const cc = (ability.ext ?? {}) as CardCombat
  if (cc.消耗 && actor.ext) {
    const aExt = actor.ext as CombatantExt
    if (cc.消耗.mp) aExt.mp = Math.max(0, (aExt.mp ?? 0) - cc.消耗.mp)
    if (cc.消耗.sp) aExt.sp = Math.max(0, (aExt.sp ?? 0) - cc.消耗.sp)
  }

  let targets: Combatant[]
  if (action.targetIds?.length) {
    const ids = new Set(action.targetIds)
    targets = state.combatants.filter((c) => ids.has(c.id))
  } else {
    const dir = octantDir(actor.pos, origin)
    targets = targetsInCells(
      state.combatants,
      clipToGrid(state.grid, templateCells(ability.shape, origin, dir))
    )
  }
  targets = targets.filter(isAlive)
  if (ability.requiresLoS)
    targets = targets.filter((t) => lineOfSight(state.grid, actor.pos, t.pos))
  // A heal only affects allies (same side as the actor); attacks hit whoever is targeted.
  const isHeal = !!cc.治疗 || (cc.治疗量 ?? 0) > 0
  if (isHeal) targets = targets.filter((t) => t.side === actor.side)
  if (cc.范围目标 && targets.length > cc.范围目标) targets = targets.slice(0, cc.范围目标)

  const events: CombatEvent[] = [
    {
      kind: 'attack',
      text: `${actor.name} uses ${ability.name}.`,
      delta: { actor: actor.id, ability: ability.id, targets: targets.map((t) => t.id) }
    }
  ]
  for (const target of targets)
    if (isHeal) poemHealOne(actor, target, ability, derive, events)
    else poemHitOne(actor, target, ability, rng, derive, events)
  return { state, events }
}

/** The 命定之诗 combat system adapter. The seam's `parseItem` returns an opaque bag; `parseCardItem`
 *  itself stays strongly typed for direct callers. `resolveAction` is the <战斗协议> resolver. */
export const poemD20System: CombatSystem = {
  parseItem: (item, kind) => parseCardItem(item, kind) as unknown as Record<string, unknown>,
  buildCombatant,
  resolveAction: poemResolveAction
}

export { ATTRS, type Attr, type CardCombat } from './poemStrike'
