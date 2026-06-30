//
// Kit → draw pile (the build=deck rule). Turns a combatant's abilities into card instances:
// N copies of 普攻, M copies of a synthesized 格挡 (grants 护盾), and skill cards by 品质.
// Pure. See duel spec §4.

import type { AbilityDef, Combatant } from '../types'
import type { CardId, CardInstance, DeckConfig } from './deckTypes'

const qualityOf = (ability: AbilityDef): string =>
  (ability.ext as { 品质?: string } | undefined)?.品质 ?? '普通'

const isBasicAttack = (ability: AbilityDef): boolean => ability.name === '普攻'

/** Energy cost: basics (普攻/格挡) cost 1; skills cost by 品质 (default 2). */
export const energyCostFor = (ability: AbilityDef, config: DeckConfig): number => {
  if (isBasicAttack(ability) || ability.name === '格挡') return 1
  return config.energyCostByQuality[qualityOf(ability)] ?? 2
}

/** Synthesize the 格挡 (Defend) ability for a combatant — grants 护盾 = round(maxHp × blockFraction). */
const makeBlockAbility = (combatant: Combatant, config: DeckConfig): AbilityDef => ({
  id: `${combatant.id}/格挡`,
  name: '格挡',
  range: 1,
  shape: { kind: 'self' },
  toHit: null,
  cost: 'action',
  ext: { 格挡: true, 护盾: Math.round(combatant.block.maxHp * config.blockFraction) }
})

export const buildDeck = (
  combatant: Combatant,
  catalog: Record<string, AbilityDef>,
  config: DeckConfig
): { cards: Record<CardId, CardInstance>; order: CardId[]; abilities: Record<string, AbilityDef> } => {
  const cards: Record<CardId, CardInstance> = {}
  const order: CardId[] = []
  const abilities: Record<string, AbilityDef> = {}

  const add = (ability: AbilityDef, copies: number): void => {
    for (let n = 1; n <= copies; n++) {
      const id: CardId = `${ability.id}#${n}`
      cards[id] = { id, abilityId: ability.id, owner: combatant.id, energyCost: energyCostFor(ability, config) }
      order.push(id)
    }
  }

  for (const abilityId of combatant.block.abilities) {
    const ability = catalog[abilityId]
    if (!ability) continue
    if (isBasicAttack(ability)) add(ability, config.basics.普攻)
    else add(ability, config.copies[qualityOf(ability)] ?? 1)
  }

  const block = makeBlockAbility(combatant, config)
  abilities[block.id] = block
  add(block, config.basics.格挡)

  return { cards, order, abilities }
}
