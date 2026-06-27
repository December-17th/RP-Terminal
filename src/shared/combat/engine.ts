// Combat core — the turn engine (Track Combat / P2).
//
// Pure module. Orchestrates initiative, turn advancement, and action application
// over a CombatState. It clones the state before mutating (so callers keep their
// copy) and derives a per-action RNG from (seed, rngCursor) so a fight is
// deterministic and resumable. A card can override a whole action's resolution via
// the injected `runHook`; otherwise the native resolver (resolver.ts) runs.

import { clone } from '../objectPath'
import { makeRng, rollD20 } from './dice'
import { reachable } from './grid'
import { abilityCost, isAlive, resolveAbility, tickConditions } from './resolver'
import type { RunHook } from './hooks'
import type {
  AbilityDef,
  Action,
  CombatEvent,
  CombatState,
  CombatStatus,
  TurnBudget
} from './types'

/** A fresh per-turn action economy: one movement, one attack, one action. */
const freshBudget = (): TurnBudget => ({ moved: false, attack: false, action: false })

export interface EngineCtx {
  /** the encounter's ability catalog (from the card bundle); keyed by ability id. */
  abilities?: Record<string, AbilityDef>
  /** card-override hook runner; omit (or return null) to use native resolution. */
  runHook?: RunHook
}

/** Seed for the current step — combines the encounter seed with the cursor so each
 *  action draws from an independent, reproducible stream. */
const seedFor = (state: CombatState): number => (state.seed + state.rngCursor) >>> 0

const sameCell = (a: [number, number], b: [number, number]): boolean =>
  a[0] === b[0] && a[1] === b[1]

/** Which side (if any) has won: a side loses when none of its members are alive. */
export const checkVictory = (state: CombatState): CombatStatus => {
  const partyAlive = state.combatants.some((c) => c.side === 'party' && isAlive(c))
  const enemyAlive = state.combatants.some((c) => c.side === 'enemy' && isAlive(c))
  if (!enemyAlive) return 'party'
  if (!partyAlive) return 'enemy'
  return 'active'
}

/** The combatant whose turn it currently is (by initiative order). */
export const currentActorId = (state: CombatState): string | undefined =>
  state.initiative[state.turnIndex]

/**
 * Roll initiative for every combatant (d20 + DEX mod) and build the shared turn
 * order, highest first. Ties break by DEX mod then id (stable + deterministic).
 * Sets turnIndex 0 / round 1.
 */
export const rollInitiative = (state: CombatState, rng = makeRng(seedFor(state))): CombatState => {
  const next = clone(state)
  for (const c of next.combatants) c.initiative = rollD20(rng, { mod: c.block.mods.DEX ?? 0 }).total
  const order = [...next.combatants].sort(
    (a, b) =>
      (b.initiative ?? 0) - (a.initiative ?? 0) ||
      (b.block.mods.DEX ?? 0) - (a.block.mods.DEX ?? 0) ||
      (a.id < b.id ? -1 : 1)
  )
  next.initiative = order.map((c) => c.id)
  next.turnIndex = 0
  next.round = 1
  next.turnUsed = freshBudget()
  next.rngCursor = state.rngCursor + 1
  return next
}

/**
 * Advance to the next living combatant in initiative order, incrementing the round
 * on wrap and ticking the new actor's conditions. If everyone is down, returns the
 * state unchanged (the caller checks victory).
 */
export const advanceTurn = (state: CombatState): CombatState => {
  const next = clone(state)
  const n = next.initiative.length
  for (let step = 0; step < n; step++) {
    next.turnIndex += 1
    if (next.turnIndex >= n) {
      next.turnIndex = 0
      next.round += 1
    }
    const actor = next.combatants.find((c) => c.id === next.initiative[next.turnIndex])
    if (actor && isAlive(actor)) {
      tickConditions(actor)
      next.turnUsed = freshBudget()
      next.log = [
        ...next.log,
        {
          kind: 'turn',
          text: `${actor.name}'s turn (round ${next.round}).`,
          delta: { actor: actor.id, round: next.round }
        }
      ]
      return next
    }
  }
  return next
}

/**
 * Apply one action and return the resulting state + the events it produced. A card
 * `resolveAction` override (if `runHook` returns non-null) replaces native
 * resolution wholesale; otherwise move / ability / improvise / end resolve natively.
 * Always advances `rngCursor` and recomputes victory.
 */
export const applyAction = async (
  state: CombatState,
  action: Action,
  ctx: EngineCtx = {}
): Promise<{ state: CombatState; events: CombatEvent[] }> => {
  if (ctx.runHook) {
    const override = await ctx.runHook('resolveAction', { state, action }, seedFor(state))
    if (override) {
      const s = clone(override.state ?? state)
      const events = override.events ?? []
      s.log = [...s.log, ...events]
      // A whole-action card override still consumes the matching turn budget.
      const used = s.turnUsed ?? freshBudget()
      if (action.kind === 'move') s.turnUsed = { ...used, moved: true }
      else if (action.kind === 'ability') {
        const ab = action.abilityId ? ctx.abilities?.[action.abilityId] : undefined
        s.turnUsed = ab ? { ...used, [abilityCost(ab)]: true } : used
      }
      s.rngCursor = state.rngCursor + 1
      s.status = checkVictory(s)
      return { state: s, events }
    }
  }

  const next = clone(state)
  const rng = makeRng(seedFor(state))
  const actor = next.combatants.find((c) => c.id === action.actor)
  const used = next.turnUsed ?? freshBudget()
  next.turnUsed = used
  let events: CombatEvent[] = []

  switch (action.kind) {
    case 'move': {
      const to = action.to
      if (used.moved) {
        events.push({
          kind: 'info',
          text: 'Already moved this turn.',
          delta: { actor: action.actor }
        })
        break
      }
      const legal =
        actor &&
        to &&
        reachable(next.grid, next.combatants, actor.id).some((cell) => sameCell(cell, to))
      if (actor && to && legal) {
        const from = actor.pos
        actor.pos = [to[0], to[1]]
        next.turnUsed = { ...used, moved: true }
        events.push({
          kind: 'move',
          text: `${actor.name} moves to (${to[0]},${to[1]}).`,
          delta: { actor: actor.id, from, to: actor.pos }
        })
      } else {
        events.push({ kind: 'info', text: 'Illegal move.', delta: { actor: action.actor } })
      }
      break
    }
    case 'ability': {
      const ab = action.abilityId ? ctx.abilities?.[action.abilityId] : undefined
      const slot = ab ? abilityCost(ab) : 'action'
      if (ab && used[slot]) {
        events.push({
          kind: 'info',
          text: `No ${slot} left this turn.`,
          delta: { actor: action.actor }
        })
        break
      }
      events = resolveAbility(next, action, ctx.abilities ?? {}, rng)
      // Consume the slot only if the ability actually fired (passed range/LoS checks).
      if (ab && events.some((e) => e.kind === 'attack')) next.turnUsed = { ...used, [slot]: true }
      break
    }
    case 'improvise':
      events.push({
        kind: 'info',
        text: `${actor?.name ?? action.actor} improvises: ${action.prose ?? ''}`.trim(),
        delta: { actor: action.actor, prose: action.prose }
      })
      break
    case 'end':
      break
  }

  next.log = [...next.log, ...events]
  next.rngCursor = state.rngCursor + 1
  next.status = checkVictory(next)
  return { state: next, events }
}
