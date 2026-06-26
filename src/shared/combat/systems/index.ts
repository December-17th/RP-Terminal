// Built-in combat-system registry. A card's combat bundle selects a system (its MVU import +
// resolver) by id; the main-process service injects the chosen system's resolveAction into the
// engine's RunHook. v1 ships one trusted built-in (命定之诗 层级-d20). A future card-SHIPPED
// resolver (untrusted, via combat.scripts) is the deferred sandbox path — same ResolverContext.

import type { CombatSystem } from '../bundle'
import { poemD20System } from './poemD20'

const SYSTEMS: Record<string, CombatSystem> = {
  poemD20: poemD20System
}

/** Look up a built-in combat system by id (e.g. a bundle's `derive.system`). */
export const getSystem = (id?: string): CombatSystem | undefined => (id ? SYSTEMS[id] : undefined)

export { poemD20System }
export type { CombatSystem }
