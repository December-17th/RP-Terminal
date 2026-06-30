//
// Resolve one card play (and, reused by intents.ts, one telegraphed action): deduct energy +
// 消耗 (mp/sp/hp), apply the effect via the shared poemStrike math, move the card to discard.
// Pure; clone-then-mutate. See duel spec §5.

import { clone } from '../../objectPath'
import { poemHitOne, poemHealOne, extOf } from '../systems/poemStrike'
import type { AbilityDef, Combatant, CombatEvent } from '../types'
import type { DeriveConfig } from '../bundle'
import type { Rng } from '../dice'
import type { DuelState } from './deckTypes'

const isAlive = (c: Combatant): boolean => c.block.hp > 0

interface PlayExt {
  格挡?: boolean
  护盾?: number
  治疗?: boolean
  治疗量?: number
  消耗?: { mp?: number; sp?: number; hp?: number }
  目标模式?: '单体' | '随机' | '群体'
  随机次数?: number
}

/**
 * Apply one ability's effect to its targets, mutating `combatants` + `events`. Branches:
 * 格挡 → grant 护盾 to the actor (tracked as blockGained for per-round decay); 治疗 → heal
 * same-side targets; otherwise → strike each target. No energy/cost bookkeeping (that's resolvePlay).
 */
export const applyAbilityEffect = (
  combatants: Combatant[],
  actorId: string,
  ability: AbilityDef,
  targetIds: string[],
  rng: Rng,
  derive: DeriveConfig | undefined,
  events: CombatEvent[]
): void => {
  const actor = combatants.find((c) => c.id === actorId)
  if (!actor) return
  const ext = (ability.ext ?? {}) as PlayExt

  if (ext.格挡) {
    const gain = ext.护盾 ?? 0
    const aExt = extOf(actor)
    aExt.shield = (aExt.shield ?? 0) + gain
    aExt.blockGained = (aExt.blockGained ?? 0) + gain
    events.push({ kind: 'info', text: `${actor.name} 获得护盾 ${gain}。`, delta: { target: actor.id, block: gain } })
    return
  }

  const isHeal = !!ext.治疗 || (ext.治疗量 ?? 0) > 0
  const side = isHeal ? actor.side : actor.side === 'party' ? 'enemy' : 'party'
  const pool = combatants.filter((c) => c.side === side && isAlive(c))
  const mode = ext.目标模式 ?? '单体'
  let targets: Combatant[]
  if (mode === '群体') {
    targets = pool
  } else if (mode === '随机' && pool.length) {
    const n = Math.max(1, ext.随机次数 ?? 1)
    targets = Array.from({ length: n }, () => pool[Math.floor(rng() * pool.length)])
  } else {
    // 单体 (default): the picked target (must be on the resolved side + alive), else first living
    const picked = pool.find((c) => targetIds.includes(c.id))
    targets = picked ? [picked] : pool.length ? [pool[0]] : []
  }

  events.push({
    kind: 'attack',
    text: `${actor.name} uses ${ability.name}.`,
    delta: { actor: actor.id, ability: ability.id, targets: targets.map((t) => t.id) }
  })
  for (const target of targets)
    if (isHeal) poemHealOne(actor, target, ability, derive, events)
    else poemHitOne(actor, target, ability, rng, derive, events)
}

const checkStatus = (combatants: Combatant[]): DuelState['status'] => {
  const partyAlive = combatants.some((c) => c.side === 'party' && isAlive(c))
  const enemyAlive = combatants.some((c) => c.side === 'enemy' && isAlive(c))
  if (!enemyAlive) return 'party'
  if (!partyAlive) return 'enemy'
  return 'active'
}

/** Resolve one card play: spend energy + 消耗, apply the effect, discard the card, recompute status. */
export const resolvePlay = (
  state: DuelState,
  cardId: string,
  targetIds: string[],
  rng: Rng,
  derive: DeriveConfig | undefined,
  catalog: Record<string, AbilityDef>
): { state: DuelState; events: CombatEvent[] } => {
  const next = clone(state)
  const card = next.cards[cardId]
  const ability = card ? catalog[card.abilityId] : undefined
  const events: CombatEvent[] = []
  if (!card || !ability) {
    events.push({ kind: 'info', text: 'No such card.', delta: { card: cardId } })
    return { state: next, events }
  }

  next.energy.current = Math.max(0, next.energy.current - card.energyCost)

  const owner = next.combatants.find((c) => c.id === card.owner)
  const cost = ((ability.ext ?? {}) as PlayExt).消耗
  if (owner && cost) {
    const oExt = extOf(owner) as { mp?: number; sp?: number }
    if (cost.mp) oExt.mp = Math.max(0, (oExt.mp ?? 0) - cost.mp)
    if (cost.sp) oExt.sp = Math.max(0, (oExt.sp ?? 0) - cost.sp)
    if (cost.hp) owner.block.hp = Math.max(0, owner.block.hp - cost.hp)
  }

  applyAbilityEffect(next.combatants, card.owner, ability, targetIds, rng, derive, events)

  next.piles.hand = next.piles.hand.filter((id) => id !== cardId)
  if (card.exhaust) next.piles.exhaust.push(cardId)
  else next.piles.discard.push(cardId)

  next.rngCursor = state.rngCursor + 1
  next.log = [...next.log, ...events]
  next.status = checkStatus(next.combatants)
  return { state: next, events }
}
