// Combat core — native d20 resolution (Track Combat / P2).
//
// Pure module. Mutates the CombatState passed in (the engine clones before calling,
// so callers/tests can pass a throwaway state) and returns the log events produced.
// All randomness flows through the injected `Rng` so resolution is deterministic
// and unit-testable. The native rules here are the default; a card can override a
// whole action via the hook seam (see engine.ts / hooks.ts).

import { rollD20, rollExpr, type Rng } from './dice'
import { clipToGrid, distance, octantDir, targetsInCells, templateCells } from './grid'
import type { AbilityDef, Action, CombatEvent, Combatant, CombatState } from './types'

/** A combatant is still in the fight while it has positive HP. */
export const isAlive = (c: Combatant): boolean => c.block.hp > 0

const findById = (state: CombatState, id: string): Combatant | undefined =>
  state.combatants.find((c) => c.id === id)

/**
 * Subtract typed damage from a target, applying resistance (half, floored) and
 * vulnerability (double). Clamps HP at 0. Returns the damage actually dealt.
 */
export const applyDamageAmount = (target: Combatant, amount: number, type?: string): number => {
  let dmg = amount
  if (type && target.block.vulnerable?.includes(type)) dmg *= 2
  else if (type && target.block.resist?.includes(type)) dmg = Math.floor(dmg / 2)
  dmg = Math.max(0, Math.floor(dmg))
  target.block.hp = Math.max(0, target.block.hp - dmg)
  return dmg
}

/** Decrement a combatant's timed conditions (called at the start of its turn);
 *  duration -1 = permanent (never ticks), reaching 0 removes the condition. */
export const tickConditions = (c: Combatant): void => {
  c.block.conditions = c.block.conditions
    .map((cd) => (cd.duration > 0 ? { ...cd, duration: cd.duration - 1 } : cd))
    .filter((cd) => cd.duration !== 0)
}

/** Resolve a single target hit/save → damage → effects, appending events. */
const hitOne = (
  actor: Combatant,
  target: Combatant,
  ability: AbilityDef,
  rng: Rng,
  events: CombatEvent[]
): void => {
  let mult = 1
  let crit = false

  if (ability.toHit) {
    const atk = rollD20(rng, { mod: actor.block.mods[ability.toHit] ?? 0 })
    crit = atk.crit
    const hit = atk.crit || (!atk.fumble && atk.total >= target.block.ac)
    if (!hit) {
      events.push({
        kind: 'miss',
        text: `${actor.name} misses ${target.name} (${atk.total} vs AC ${target.block.ac}).`,
        delta: { target: target.id }
      })
      return
    }
  } else if (ability.save) {
    const sv = rollD20(rng, { mod: target.block.mods[ability.save.ability] ?? 0 })
    const success = sv.total >= ability.save.dc
    mult = success ? (ability.save.onSuccess ?? 0) : 1
    events.push({
      kind: 'save',
      text: `${target.name} ${success ? 'succeeds' : 'fails'} a ${ability.save.ability} save (${sv.total} vs DC ${ability.save.dc}).`,
      delta: { target: target.id, success }
    })
  }

  if (ability.damage && mult > 0) {
    const r = rollExpr(rng, ability.damage, actor.block.mods, crit ? 2 : 1)
    const dealt = applyDamageAmount(target, Math.floor(r.total * mult), ability.damageType)
    events.push({
      kind: 'damage',
      text: `${target.name} takes ${dealt}${crit ? ' (crit!)' : ''} — HP ${target.block.hp}/${target.block.maxHp}.`,
      delta: { target: target.id, damage: dealt, hp: target.block.hp }
    })
  }

  // Effects land on a hit or a failed save (mult > 0), never on a successful save.
  if (mult > 0 && ability.effects?.length) {
    for (const e of ability.effects) {
      if (!target.block.conditions.some((c) => c.id === e.id))
        target.block.conditions.push({ ...e })
    }
    events.push({
      kind: 'condition',
      text: `${target.name}: ${ability.effects.map((e) => e.id).join(', ')}.`,
      delta: { target: target.id, conditions: ability.effects.map((e) => e.id) }
    })
  }

  if (target.block.hp <= 0) {
    events.push({
      kind: 'death',
      text: `${target.name} is down!`,
      delta: { target: target.id, dead: true }
    })
  }
}

/**
 * Resolve an ability action: validate range, collect targets (explicit ids or the
 * AoE template's covered cells), then resolve each living target. Mutates `state`
 * and returns the events.
 */
export const resolveAbility = (
  state: CombatState,
  action: Action,
  abilities: Record<string, AbilityDef>,
  rng: Rng
): CombatEvent[] => {
  const events: CombatEvent[] = []
  const actor = findById(state, action.actor)
  const ability = action.abilityId ? abilities[action.abilityId] : undefined
  if (!actor || !ability) {
    events.push({ kind: 'info', text: 'No such ability.', delta: { actor: action.actor } })
    return events
  }

  const origin = action.targetCell ?? actor.pos
  if (distance(actor.pos, origin) > ability.range) {
    events.push({
      kind: 'info',
      text: `${ability.name} is out of range.`,
      delta: { actor: actor.id }
    })
    return events
  }

  let targets: Combatant[]
  if (action.targetIds?.length) {
    const ids = new Set(action.targetIds)
    targets = state.combatants.filter((c) => ids.has(c.id))
  } else {
    const dir = octantDir(actor.pos, origin)
    const cells = clipToGrid(state.grid, templateCells(ability.shape, origin, dir))
    targets = targetsInCells(state.combatants, cells)
  }
  targets = targets.filter(isAlive)

  events.push({
    kind: 'attack',
    text: `${actor.name} uses ${ability.name}.`,
    delta: { actor: actor.id, ability: ability.id, targets: targets.map((t) => t.id) }
  })
  for (const target of targets) hitOne(actor, target, ability, rng, events)
  return events
}
