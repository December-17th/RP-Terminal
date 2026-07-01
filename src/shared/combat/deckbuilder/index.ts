// src/shared/combat/deckbuilder/index.ts
//
// Public entry for the 命定之诗 deckbuilder duel engine (headless). Binds the poem CombatSystem
// to the existing MVU encounter builder, and re-exports the turn-loop API. See duel spec §1, §5.

import { buildEncounterFromMvu, type BuiltEncounter, type DeriveConfig, type StatMap } from '../bundle'
import { poemD20System } from '../systems/poemD20'

export * from './deckTypes'
export { buildDeck, energyCostFor } from './deckBuild'
export { resolvePlay, applyAbilityEffect } from './deckResolve'
export { chooseIntent, resolveIntent } from './intents'
export { startDuel, drawHand, playCard, endLeadTurn, checkDuelVictory, swapLeadIfDown } from './deckEngine'
export { buildDuelNarrationPrompt, describeDuelState } from './duelNarration'

/**
 * Build a duel encounter from MVU stat_data via the poem CombatSystem: the player + 关系列表 party
 * and the AI-supplied `roster` enemies (A1). Reuses buildEncounterFromMvu; the grid it returns is
 * ignored by the deck engine (targeting is by id).
 */
export const buildDuelFromMvu = (
  statData: Record<string, unknown>,
  statMap: StatMap,
  opts: { derive?: DeriveConfig; seed?: number; roster?: Array<Record<string, unknown>> } = {}
): BuiltEncounter =>
  buildEncounterFromMvu(statData, statMap, poemD20System, {
    derive: opts.derive,
    seed: opts.seed,
    roster: opts.roster
  })
