// Combat core — native weighted enemy policy (Track Combat / P3).
//
// Pure module. Decides one action for an automated combatant via a deterministic
// weighted heuristic — no RNG, so an AI-free fight is fully reproducible. This is
// the default enemy controller; the alternative `ai` controller (the model picks
// from the legal set) is wired in the main-process orchestration (P4/P6), not here.
// See docs/combat-system-design.md §6.

import { averageExpr } from './dice'
import { distance, reachable } from './grid'
import { isAlive } from './resolver'
import type { AbilityDef, Action, Combatant, Coord, CombatState } from './types'

/** Reachable cell that minimizes (dir=+1, close in) or maximizes (dir=-1, flee)
 *  distance to `target`. Deterministic tie-break by coordinate. */
const stepToward = (
  state: CombatState,
  self: Combatant,
  target: Coord,
  dir: 1 | -1
): Coord | null => {
  const cells = reachable(state.grid, state.combatants, self.id)
  if (!cells.length) return null
  return [...cells].sort((a, b) => {
    const da = distance(a, target)
    const db = distance(b, target)
    if (da !== db) return dir > 0 ? da - db : db - da
    return a[0] - b[0] || a[1] - b[1]
  })[0]
}

/**
 * Choose an action for `enemyId`:
 *  1. if an attack can secure a kill, take it;
 *  2. if badly hurt (≤25% HP), flee from the nearest foe;
 *  3. else take the best in-range attack (favoring the most wounded foe);
 *  4. else close on the nearest foe;
 *  5. else end the turn.
 * `abilities` is the encounter's ability catalog. Returns a legal `Action`.
 */
export const weightedPolicy = (
  state: CombatState,
  enemyId: string,
  abilities: Record<string, AbilityDef>
): Action => {
  const self = state.combatants.find((c) => c.id === enemyId)
  if (!self) return { kind: 'end', actor: enemyId }
  const foes = state.combatants.filter((c) => c.side !== self.side && isAlive(c))
  if (!foes.length) return { kind: 'end', actor: enemyId }

  const myAbilities = self.block.abilities
    .map((id) => abilities[id])
    .filter((a): a is AbilityDef => !!a)

  let best: { score: number; action: Action } | null = null
  for (const ab of myAbilities) {
    for (const foe of foes) {
      if (distance(self.pos, foe.pos) > ab.range) continue
      const dmg = ab.damage ? averageExpr(ab.damage, self.block.mods) : 0
      let score = dmg
      if (dmg >= foe.block.hp) score += 1000 // secures a kill
      score += (foe.block.maxHp - foe.block.hp) * 0.1 // focus the wounded
      if (!best || score > best.score) {
        best = {
          score,
          action: {
            kind: 'ability',
            actor: enemyId,
            abilityId: ab.id,
            targetCell: [foe.pos[0], foe.pos[1]],
            targetIds: [foe.id]
          }
        }
      }
    }
  }

  const nearest = foes.reduce((a, b) =>
    distance(self.pos, a.pos) <= distance(self.pos, b.pos) ? a : b
  )

  if (best && best.score >= 1000) return best.action

  if (self.block.hp <= self.block.maxHp * 0.25) {
    const away = stepToward(state, self, nearest.pos, -1)
    if (away) return { kind: 'move', actor: enemyId, to: away }
  }

  if (best) return best.action

  const toward = stepToward(state, self, nearest.pos, 1)
  if (toward) return { kind: 'move', actor: enemyId, to: toward }

  return { kind: 'end', actor: enemyId }
}
