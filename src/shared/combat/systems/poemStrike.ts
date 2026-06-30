// src/shared/combat/systems/poemStrike.ts
//
// 命定之诗 strike primitives — the grid-INDEPENDENT half of the <战斗协议> resolver,
// extracted from poemD20.ts so BOTH the grid resolver (poemD20.poemResolveAction) and the
// deckbuilder duel resolver reuse the exact same 检定→评级→伤害→护盾→状态 math.
// Pure module. See docs/combat-poem-of-destiny-expansion.md and the duel spec §5.1.

import { rollD20, type Rng } from '../dice'
import { applyDamageAmount } from '../resolver'
import type { AbilityDef, Combatant, CombatEvent } from '../types'
import type { DeriveConfig } from '../bundle'

/** The five attributes, in canonical order (also `derive.attributes`). */
export const ATTRS = ['力量', '敏捷', '体质', '智力', '精神'] as const
export type Attr = (typeof ATTRS)[number]

/** Normalized combat numbers parsed off one 技能/装备, carried on `AbilityDef.ext` / combatant ext. */
export interface CardCombat {
  品质?: string
  类型?: string
  关联属性?: Attr
  威力?: number
  攻击?: number
  防御?: number
  消耗?: { slot: 'attack' | 'action'; mp?: number; sp?: number; hp?: number }
  range?: number
  shape?: import('../types').AoeShape
  范围目标?: number
  命中?: number
  闪避?: number
  先攻?: number
  抵抗?: number
  额外固定伤害?: number
  DR?: number
  穿透?: number
  暴击倍率?: number
  伤害增幅?: number
  护盾?: number
  治疗?: boolean
  治疗增幅?: number
  治疗量?: number
  附加效果?: { 状态: string; 数值?: number; 回合: number }[]
  多段?: number
  需视线?: boolean
}

/** The shape buildCombatant writes into `Combatant.ext`. */
export interface CombatantExt {
  attrs?: Record<string, number>
  tier?: number
  level?: number
  mp?: number
  maxMp?: number
  sp?: number
  maxSp?: number
  equip?: { 武器攻击?: number; 防御?: number; 命中?: number; 闪避?: number; DR?: number }
  伤害增幅?: number
  治疗增幅?: number
  shield?: number
  /** temporary block from 格挡 this round; decayed at round end (deckEngine). */
  blockGained?: number
  passives?: { name: string; combat: CardCombat }[]
}

export const extOf = (c: Combatant): CombatantExt => (c.ext ?? {}) as CombatantExt

const DEFAULT_RATING: [number, number][] = [
  [30, 2.0],
  [25, 1.6],
  [20, 1.3],
  [11, 1.0],
  [8, 0.8],
  [4, 0.3],
  [0, 0]
]

/** 检定总值 → 评级系数 (first tier whose threshold the total meets). */
const rating = (total: number, derive?: DeriveConfig): number => {
  for (const [thr, mult] of derive?.rating_tiers ?? DEFAULT_RATING) if (total >= thr) return mult
  return 0
}

/** 属性减免 fraction (physical only — typed-damage split is a later refinement). */
const physMitFraction = (tExt: CombatantExt, derive?: DeriveConfig): number => {
  const a = tExt.attrs ?? {}
  const f = derive?.attr_mitigation?.物理 ?? 0.0025
  return Math.min(0.9, ((a.体质 ?? 0) + (a.力量 ?? 0) + (a.敏捷 ?? 0)) * f)
}

const targetDR = (tExt: CombatantExt): number => {
  let dr = tExt.equip?.DR ?? 0
  for (const p of tExt.passives ?? []) if (p.combat.DR) dr = Math.max(dr, p.combat.DR)
  return dr
}

/** 附加效果 opposition: (攻方关联属性 + d20) vs (守方 max(体质,精神) + d20). */
const opposition = (attackerAttrV: number, tExt: CombatantExt, rng: Rng): boolean => {
  const a = tExt.attrs ?? {}
  const tResist = Math.max(a.体质 ?? 0, a.精神 ?? 0)
  return attackerAttrV + rollD20(rng).natural >= tResist + rollD20(rng).natural
}

/** Resolve one attacker→target strike per 战斗协议 第三阶段 (评级 → 伤害 → 状态), appending events. */
export const poemHitOne = (
  actor: Combatant,
  target: Combatant,
  ability: AbilityDef,
  rng: Rng,
  derive: DeriveConfig | undefined,
  events: CombatEvent[]
): void => {
  const aExt = extOf(actor)
  const tExt = extOf(target)
  const cc = (ability.ext ?? {}) as CardCombat & { 武器攻击?: number }
  const atkTier = aExt.tier ?? 1
  const defTier = tExt.tier ?? 1

  const roll = rollD20(rng, { adv: atkTier > defTier, dis: atkTier < defTier })
  const 命中 = Math.max(cc.命中 ?? 0, aExt.equip?.命中 ?? 0)
  let 闪避 = tExt.equip?.闪避 ?? 0
  if (atkTier > defTier + 1) 闪避 = 0
  const total = roll.natural + 命中 - 闪避
  const K = rating(total, derive)
  if (K <= 0) {
    events.push({
      kind: 'miss',
      text: `${actor.name} misses ${target.name} (检定 ${total}).`,
      delta: { target: target.id, total }
    })
    return
  }

  const attr = (cc.关联属性 ?? '力量') as Attr
  const attrV = aExt.attrs?.[attr] ?? 0
  const coeff = derive?.tier_coefficient?.[String(atkTier)] ?? 1
  const 威力 = cc.威力 ?? 20
  const 武器攻击 = cc.武器攻击 ?? aExt.equip?.武器攻击 ?? 0
  const 构成 = attrV * 10 * coeff + 威力 + 武器攻击
  const defConst = derive?.defense_constant ?? 2000
  const effDef = (tExt.equip?.防御 ?? 0) * (1 - (cc.穿透 ?? 0) / 100)
  const afterEquip = 构成 * (defConst / (effDef + defConst))
  const J = afterEquip * (1 - physMitFraction(tExt, derive))
  const hits = cc.多段 && cc.多段 > 1 ? cc.多段 : 1
  let dmg = J * K + (cc.额外固定伤害 ?? 0) * hits
  const amp = (cc.伤害增幅 ?? 0) + (aExt.伤害增幅 ?? 0)
  if (amp) dmg *= 1 + amp / 100
  dmg *= 1 - targetDR(tExt) / 100
  dmg = Math.max(0, Math.floor(dmg))

  let absorbed = 0
  if (tExt.shield && tExt.shield > 0 && dmg > 0) {
    absorbed = Math.min(tExt.shield, dmg)
    tExt.shield -= absorbed
    dmg -= absorbed
  }
  const dealt = applyDamageAmount(target, dmg)
  events.push({
    kind: 'damage',
    text: `${target.name} takes ${dealt}${absorbed ? ` (护盾吸收 ${absorbed})` : ''} (评级 ×${K}) — HP ${target.block.hp}/${target.block.maxHp}.`,
    delta: {
      target: target.id,
      damage: dealt,
      hp: target.block.hp,
      rating: K,
      ...(absorbed ? { shieldAbsorbed: absorbed, shieldLeft: tExt.shield } : {})
    }
  })

  const eff = cc.附加效果 ?? []
  if (eff.length) {
    const apply = K >= 1.3 ? true : K >= 0.8 ? opposition(attrV, tExt, rng) : false
    if (apply) {
      for (const e of eff)
        if (!target.block.conditions.some((c) => c.id === e.状态))
          target.block.conditions.push({ id: e.状态, duration: e.回合 })
      events.push({
        kind: 'condition',
        text: `${target.name}: ${eff.map((e) => e.状态).join(', ')}.`,
        delta: { target: target.id, conditions: eff.map((e) => e.状态) }
      })
    }
  }

  if (target.block.hp <= 0)
    events.push({
      kind: 'death',
      text: `${target.name} is down!`,
      delta: { target: target.id, dead: true }
    })
}

/** Resolve one heal: restore HP to an ally — no 命中检定, no mitigation; 治疗增幅 amplifies. */
export const poemHealOne = (
  actor: Combatant,
  target: Combatant,
  ability: AbilityDef,
  derive: DeriveConfig | undefined,
  events: CombatEvent[]
): void => {
  const aExt = extOf(actor)
  const cc = (ability.ext ?? {}) as CardCombat
  const attr = (cc.关联属性 ?? '精神') as Attr
  const attrV = aExt.attrs?.[attr] ?? 0
  const coeff = derive?.tier_coefficient?.[String(aExt.tier ?? 1)] ?? 1
  const base = (cc.治疗 ? attrV * 10 * coeff + (cc.威力 ?? 0) : 0) + (cc.治疗量 ?? 0)
  const amp = (cc.治疗增幅 ?? 0) + (aExt.治疗增幅 ?? 0)
  const heal = Math.max(0, Math.floor(base * (1 + amp / 100)))
  const before = target.block.hp
  target.block.hp = Math.min(target.block.maxHp, before + heal)
  events.push({
    kind: 'heal',
    text: `${target.name} recovers ${target.block.hp - before} — HP ${target.block.hp}/${target.block.maxHp}.`,
    delta: { target: target.id, heal: target.block.hp - before, hp: target.block.hp }
  })
}
