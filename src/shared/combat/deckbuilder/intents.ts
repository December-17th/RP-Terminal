//
// Deterministic telegraphed intents for non-lead combatants (companions + enemies). No per-turn
// LLM — this is the readable-pattern core of STS, and the seam mode ③ (agent enemy) later replaces.
// Pure. See duel spec §5.

import { applyAbilityEffect } from './deckResolve'
import { extOf } from '../systems/poemStrike'
import type { AbilityDef, Combatant, CombatEvent, Side } from '../types'
import type { DeriveConfig } from '../bundle'
import type { Rng } from '../dice'
import type { DuelState, Intent, IntentKind } from './deckTypes'

const opponentSide = (side: Side): Side => (side === 'party' ? 'enemy' : 'party')

const kindOf = (ability: AbilityDef): IntentKind => {
  const ext = (ability.ext ?? {}) as { 治疗?: boolean; 治疗量?: number; 格挡?: boolean }
  if (ext.格挡) return 'block'
  if (ext.治疗 || (ext.治疗量 ?? 0) > 0) return 'heal'
  return 'attack'
}

/** Coarse damage estimate for the telegraph: 构成 base (关联属性×10×系数 + 威力). */
const previewOf = (actor: Combatant, ability: AbilityDef, derive?: DeriveConfig): number => {
  const ext = (ability.ext ?? {}) as { 威力?: number; 关联属性?: string }
  const aExt = extOf(actor)
  const attrV = ext.关联属性 ? aExt.attrs?.[ext.关联属性] ?? 0 : 0
  const coeff = derive?.tier_coefficient?.[String(aExt.tier ?? 1)] ?? 1
  return Math.round(attrV * 10 * coeff + (ext.威力 ?? 0))
}

/** Pick a combatant's next action: its first non-普攻 ability (else 普攻), aimed at the first living
 *  opponent. Deterministic. */
export const chooseIntent = (
  state: DuelState,
  combatantId: string,
  catalog: Record<string, AbilityDef>,
  derive?: DeriveConfig
): Intent => {
  const actor = state.combatants.find((c) => c.id === combatantId)
  if (!actor) return { kind: 'attack' }
  const abilities = actor.block.abilities.map((id) => catalog[id]).filter(Boolean) as AbilityDef[]
  const ability = abilities.find((a) => a.name !== '普攻') ?? abilities[0]
  const target = state.combatants.find((c) => c.side === opponentSide(actor.side) && c.block.hp > 0)
  if (!ability) return { kind: 'attack', target: target?.id }
  const kind = kindOf(ability)
  return {
    kind,
    abilityId: ability.id,
    target: kind === 'block' ? actor.id : target?.id,
    preview: kind === 'attack' ? previewOf(actor, ability, derive) : ability.ext ? (ability.ext as { 护盾?: number }).护盾 : undefined
  }
}

/** Execute a telegraphed intent (attack / heal / block) via the shared effect applier. */
export const resolveIntent = (
  combatants: Combatant[],
  combatantId: string,
  intent: Intent,
  rng: Rng,
  derive: DeriveConfig | undefined,
  catalog: Record<string, AbilityDef>,
  events: CombatEvent[]
): void => {
  if (!intent.abilityId) return
  const ability = catalog[intent.abilityId]
  if (!ability) return
  const targetIds = intent.target ? [intent.target] : []
  applyAbilityEffect(combatants, combatantId, ability, targetIds, rng, derive, events)
}
