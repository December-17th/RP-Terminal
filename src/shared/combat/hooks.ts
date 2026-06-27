// Combat core — the card-override hook seam (Track Combat / P2).
//
// Pure module. The engine resolves everything natively by default; a world's
// `combat.scripts` can override resolution by supplying a `RunHook`. This keeps
// src/shared/combat pure: the SANDBOX that actually runs untrusted card code lives
// in the main process (combatService injects a RunHook backed by `runSandbox`).
// The pure core never imports the sandbox. See docs/combat-system-design.md §5.

import type { Action, CombatEvent, CombatState } from './types'

/** Override points. P2 wires `resolveAction` (whole-action override); the rest are
 *  reserved for finer-grained native hooks added in later phases. */
export type HookName =
  | 'resolveAction'
  | 'seedCombatant'
  | 'onTurnStart'
  | 'onTurnEnd'
  | 'enemyPolicy'
  | 'checkVictory'

export interface HookInput {
  state: CombatState
  action?: Action
}

/** A card override's return. `state` (when present) replaces the engine's result
 *  for this step; `events` are appended to the log. Returning `null` from `RunHook`
 *  means "no override — use the native implementation." */
export interface HookResult {
  state?: CombatState
  events?: CombatEvent[]
}

/**
 * Injected by the caller. Runs a card-authored override for a hook (sandboxed in
 * main) and returns its result, or `null` when the card defines no override. The
 * `seed` is derived from the CombatState so the override stays deterministic.
 */
export type RunHook = (name: HookName, input: HookInput, seed: number) => Promise<HookResult | null>

/** The default: no card overrides — every hook falls through to native logic. */
export const noHooks: RunHook = async () => null
