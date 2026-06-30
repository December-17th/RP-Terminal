// src/shared/combat/deckbuilder/deckTypes.ts
//
// Pure model for the 命定之诗 deckbuilder duel (STS mode). Sits on top of the existing
// Combatant/ext model (src/shared/combat/types.ts); targeting is by combatant id, not grid.
// See docs/superpowers/specs/2026-06-30-poem-sts-card-duel-design.md §3.

import type { Combatant, CombatEvent, Side } from '../types'

export type CardId = string

export interface CardInstance {
  id: CardId
  abilityId: string
  owner: string
  energyCost: number
  exhaust?: boolean
}

export type IntentKind = 'attack' | 'block' | 'buff' | 'heal'

export interface Intent {
  kind: IntentKind
  abilityId?: string
  target?: string
  preview?: number
}

export type DuelPhase = 'lead' | 'allies' | 'enemies'
export type DuelStatus = 'active' | 'party' | 'enemy'

export interface DuelState {
  seed: number
  rngCursor: number
  combatants: Combatant[]
  lead: string
  energy: { current: number; max: number }
  piles: { draw: CardId[]; hand: CardId[]; discard: CardId[]; exhaust: CardId[] }
  cards: Record<CardId, CardInstance>
  intents: Record<string, Intent>
  phase: DuelPhase
  round: number
  status: DuelStatus
  log: CombatEvent[]
  handSize: number
}

export interface DeckConfig {
  handSize: number
  energy: number
  basics: { 普攻: number; 格挡: number }
  /** 品质 → copies of a skill card in the deck. */
  copies: Record<string, number>
  /** 品质 → energy cost of a skill card (basics cost 1). */
  energyCostByQuality: Record<string, number>
  /** 格挡 grants 护盾 = round(maxHp × blockFraction). */
  blockFraction: number
}

export const DEFAULT_DECK_CONFIG: DeckConfig = {
  handSize: 5,
  energy: 3,
  basics: { 普攻: 4, 格挡: 4 },
  copies: { 普通: 2, 优良: 2, 精良: 1, 史诗: 1, 传说: 1, 神: 1 },
  energyCostByQuality: { 普通: 1, 优良: 1, 精良: 2, 史诗: 2, 传说: 3, 神: 3 },
  blockFraction: 0.05
}

export const leadCombatant = (state: DuelState): Combatant | undefined =>
  state.combatants.find((c) => c.id === state.lead)

export const aliveOnSide = (state: DuelState, side: Side): Combatant[] =>
  state.combatants.filter((c) => c.side === side && c.block.hp > 0)
