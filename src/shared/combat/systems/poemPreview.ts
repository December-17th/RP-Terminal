// src/shared/combat/systems/poemPreview.ts
//
// Poem build-preview producer: runs the engine over a 命定之诗 build and maps the result to the
// generic DuelPreview contract. POEM-SPECIFIC (reads the poem ext / CardCombat) — kept here, not in
// the generic deckbuilder, per the generic-engine principle. Interim: calls poemD20System directly;
// moves onto a CombatSystem.buildPreview hook at engine genericization.

import { buildEncounterFromMvu, type DeriveConfig, type StatMap } from '../bundle'
import { buildDeck, energyCostFor } from '../deckbuilder/deckBuild'
import { DEFAULT_DECK_CONFIG, type DeckConfig } from '../deckbuilder/deckTypes'
import { extOf, type CardCombat, type CombatantExt } from './poemStrike'
import { poemD20System } from './poemD20'
import type { AbilityDef, Combatant } from '../types'
import type { CardPreview, CombatantPreview, DuelPreview } from '../deckbuilder/preview'

const RARITY_KEY: Record<string, string> = {
  普通: 'common', 优良: 'uncommon', 精良: 'rare', 史诗: 'epic', 传说: 'legendary', 神: 'mythic'
}

const cardKind = (name: string, cc: CardCombat): CardPreview['kind'] => {
  if (name === '格挡') return 'defend'
  if (cc.治疗 || (cc.治疗量 ?? 0) > 0) return 'heal'
  if (cc.类型 === '被动') return 'power'
  if (name === '普攻') return 'attack'
  return cc.威力 != null ? 'attack' : 'skill'
}

const effectLines = (cc: CardCombat): string[] => {
  const out: string[] = []
  if (cc.shape && cc.shape.kind !== 'self') out.push(cc.shape.kind)
  if (cc.多段 && cc.多段 > 1) out.push(`连击 ${cc.多段}`)
  if (cc.额外固定伤害) out.push(`固伤 ${cc.额外固定伤害}`)
  if (cc.护盾) out.push(`护盾 ${cc.护盾}`)
  if (cc.伤害增幅) out.push(`伤害增幅 ${cc.伤害增幅}%`)
  if (cc.治疗增幅) out.push(`治疗增幅 ${cc.治疗增幅}%`)
  for (const e of cc.附加效果 ?? []) out.push(`${e.状态} ${e.数值 ?? ''}/${e.回合}回合`.replace(' /', '/'))
  return out
}

const toCard = (
  abilityId: string,
  ability: AbilityDef,
  copies: number,
  config: DeckConfig
): CardPreview => {
  const cc = (ability.ext ?? {}) as CardCombat
  return {
    id: abilityId,
    name: ability.name,
    rarityKey: RARITY_KEY[cc.品质 ?? '普通'] ?? 'common',
    rarityLabel: cc.品质 ?? '普通',
    kind: cardKind(ability.name, cc),
    energyCost: energyCostFor(ability, config),
    resourceCost: {
      ...(cc.消耗?.mp ? { mp: cc.消耗.mp } : {}),
      ...(cc.消耗?.sp ? { sp: cc.消耗.sp } : {}),
      ...(cc.消耗?.hp ? { hp: cc.消耗.hp } : {})
    },
    ...(cc.关联属性 ? { scalingAttr: cc.关联属性 } : {}),
    ...(cc.威力 != null ? { power: cc.威力 } : {}),
    effectLines: effectLines(cc),
    copies
  }
}

const MOD_LABELS: { key: keyof NonNullable<CombatantExt['equip']>; label: string }[] = [
  { key: '武器攻击', label: '攻击' }, { key: '防御', label: '防御' },
  { key: '命中', label: '命中' }, { key: '闪避', label: '闪避' }, { key: 'DR', label: '减伤' }
]

const toCombatant = (c: Combatant, catalog: Record<string, AbilityDef>, config: DeckConfig): CombatantPreview => {
  const ext = extOf(c)
  const deck = buildDeck(c, catalog, config)
  const merged = { ...catalog, ...deck.abilities }
  // aggregate copies per abilityId, preserving first-seen order
  const counts = new Map<string, number>()
  for (const cid of deck.order) {
    const aid = deck.cards[cid].abilityId
    counts.set(aid, (counts.get(aid) ?? 0) + 1)
  }
  const cards: CardPreview[] = [...counts.entries()].map(([aid, n]) => toCard(aid, merged[aid], n, config))
  const equip = ext.equip ?? {}
  const modifiers = MOD_LABELS
    .filter(m => (equip[m.key] ?? 0) !== 0)
    .map(m => ({ key: String(m.key), label: m.label, value: equip[m.key] as number }))
  return {
    id: c.id,
    name: c.name,
    tier: ext.tier ?? 1,
    level: typeof ext.level === 'number' ? ext.level : 0,
    resources: {
      hp: c.block.hp, maxHp: c.block.maxHp,
      mp: ext.mp ?? 0, maxMp: ext.maxMp ?? 0, sp: ext.sp ?? 0, maxSp: ext.maxSp ?? 0
    },
    modifiers,
    conditions: c.block.conditions.map(cd => ({
      id: cd.id, label: cd.id, turns: cd.duration > 0 ? cd.duration : undefined, kind: 'debuff' as const
    })),
    deck: cards
  }
}

export const buildDuelPreview = (
  statData: Record<string, unknown>,
  statMap: StatMap,
  opts: { derive?: DeriveConfig; config?: DeckConfig } = {}
): DuelPreview => {
  const config = opts.config ?? DEFAULT_DECK_CONFIG
  const built = buildEncounterFromMvu(statData, statMap, poemD20System, { derive: opts.derive })
  const party = built.combatants.filter(c => c.side === 'party')
  const lead = party[0]
  return {
    config: { energyPerTurn: config.energy, handSize: config.handSize },
    lead: toCombatant(lead, built.abilities, config),
    party: party.slice(1).map(c => toCombatant(c, built.abilities, config))
  }
}
