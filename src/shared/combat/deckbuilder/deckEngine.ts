// src/shared/combat/deckbuilder/deckEngine.ts
//
// The deckbuilder turn loop: build/shuffle the shared deck, draw/play/discard, run the
// allies + enemies intent phases, decay block, refresh energy. Pure; clone-then-mutate;
// (seed, rngCursor)-deterministic. See duel spec §5.

import { clone } from '../../objectPath'
import { makeRng } from '../dice'
import { buildDeck } from './deckBuild'
import { resolvePlay } from './deckResolve'
import { chooseIntent, resolveIntent } from './intents'
import { extOf } from '../systems/poemStrike'
import type { BuiltEncounter, DeriveConfig } from '../bundle'
import type { AbilityDef, CombatEvent } from '../types'
import { DEFAULT_DECK_CONFIG, type DeckConfig, type DuelState } from './deckTypes'

const seedFor = (state: DuelState): number => (state.seed + state.rngCursor) >>> 0

/** Seeded Fisher–Yates over a copy; bumps the cursor on the returned state by the caller. */
const shuffle = <T,>(items: T[], rng: () => number): T[] => {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const checkDuelVictory = (state: DuelState): DuelState['status'] => {
  const partyAlive = state.combatants.some((c) => c.side === 'party' && c.block.hp > 0)
  const enemyAlive = state.combatants.some((c) => c.side === 'enemy' && c.block.hp > 0)
  if (!enemyAlive) return 'party'
  if (!partyAlive) return 'enemy'
  return 'active'
}

export const swapLeadIfDown = (state: DuelState): DuelState => {
  const lead = state.combatants.find((c) => c.id === state.lead)
  if (lead && lead.block.hp > 0) return state
  const next = clone(state)
  const successor = next.combatants.find((c) => c.side === 'party' && c.block.hp > 0)
  if (successor) next.lead = successor.id
  return next
}

const telegraph = (state: DuelState, catalog: Record<string, AbilityDef>, derive?: DeriveConfig): void => {
  state.intents = {}
  for (const c of state.combatants)
    if (c.id !== state.lead && c.block.hp > 0) state.intents[c.id] = chooseIntent(state, c.id, catalog, derive)
}

export const drawHand = (state: DuelState): DuelState => {
  const next = clone(state)
  while (next.piles.hand.length < next.handSize) {
    if (next.piles.draw.length === 0) {
      if (next.piles.discard.length === 0) break
      const rng = makeRng(seedFor(next))
      next.piles.draw = shuffle(next.piles.discard, rng)
      next.piles.discard = []
      next.rngCursor += 1
    }
    next.piles.hand.push(next.piles.draw.shift()!)
  }
  return next
}

export const startDuel = (
  built: BuiltEncounter,
  opts: { seed?: number; lead?: string; config?: DeckConfig } = {}
): { state: DuelState; catalog: Record<string, AbilityDef> } => {
  const config = opts.config ?? DEFAULT_DECK_CONFIG
  const seed = opts.seed ?? built.seed ?? 1
  const party = built.combatants.filter((c) => c.side === 'party')
  const lead = opts.lead ?? party[0]?.id ?? built.combatants[0]?.id

  const catalog: Record<string, AbilityDef> = { ...built.abilities }
  const cards: DuelState['cards'] = {}
  let order: string[] = []
  for (const member of party) {
    const deck = buildDeck(member, catalog, config)
    Object.assign(catalog, deck.abilities)
    Object.assign(cards, deck.cards)
    order = order.concat(deck.order)
  }

  let state: DuelState = {
    seed,
    rngCursor: 0,
    combatants: built.combatants,
    lead,
    energy: { current: config.energy, max: config.energy },
    piles: { draw: [], hand: [], discard: [], exhaust: [] },
    cards,
    intents: {},
    phase: 'lead',
    round: 1,
    status: 'active',
    log: [],
    handSize: config.handSize
  }
  state.piles.draw = shuffle(order, makeRng(seedFor(state)))
  state.rngCursor += 1
  telegraph(state, catalog)
  state = drawHand(state)
  return { state, catalog }
}

const canAfford = (state: DuelState, cardId: string, catalog: Record<string, AbilityDef>): boolean => {
  const card = state.cards[cardId]
  if (!card || !state.piles.hand.includes(cardId)) return false
  if (state.energy.current < card.energyCost) return false
  const owner = state.combatants.find((c) => c.id === card.owner)
  const cost = ((catalog[card.abilityId]?.ext ?? {}) as { 消耗?: { mp?: number; sp?: number; hp?: number } }).消耗
  if (owner && cost) {
    const oExt = extOf(owner)
    if (cost.mp && (oExt.mp ?? 0) < cost.mp) return false
    if (cost.sp && (oExt.sp ?? 0) < cost.sp) return false
    if (cost.hp && owner.block.hp <= cost.hp) return false
  }
  return true
}

export const playCard = (
  state: DuelState,
  cardId: string,
  targetIds: string[],
  catalog: Record<string, AbilityDef>,
  derive?: DeriveConfig
): { state: DuelState; events: CombatEvent[] } => {
  if (!canAfford(state, cardId, catalog)) {
    const events: CombatEvent[] = [{ kind: 'info', text: 'Cannot play that card.', delta: { card: cardId } }]
    return { state: { ...state, log: [...state.log, ...events] }, events }
  }
  return resolvePlay(state, cardId, targetIds, makeRng(seedFor(state)), derive, catalog)
}

const decayBlock = (state: DuelState): void => {
  for (const c of state.combatants) {
    const ext = extOf(c) as { shield?: number; blockGained?: number }
    if (ext.blockGained) {
      ext.shield = Math.max(0, (ext.shield ?? 0) - ext.blockGained)
      ext.blockGained = 0
    }
  }
}

export const endLeadTurn = (
  state: DuelState,
  catalog: Record<string, AbilityDef>,
  derive?: DeriveConfig
): { state: DuelState; events: CombatEvent[] } => {
  let next = clone(state)
  const events: CombatEvent[] = []

  // Discard the hand.
  next.piles.discard = [...next.piles.discard, ...next.piles.hand]
  next.piles.hand = []

  // Allies phase, then enemies phase: each living non-lead combatant resolves its telegraphed intent.
  const act = (side: 'party' | 'enemy'): void => {
    for (const c of next.combatants) {
      if (c.side !== side || c.id === next.lead || c.block.hp <= 0) continue
      const intent = next.intents[c.id]
      if (!intent) continue
      const rng = makeRng(seedFor(next))
      resolveIntent(next.combatants, c.id, intent, rng, derive, catalog, events)
      next.rngCursor += 1
    }
  }
  next.phase = 'allies'
  act('party')
  next.phase = 'enemies'
  act('enemy')

  decayBlock(next)
  next.status = checkDuelVictory(next)
  next.log = [...next.log, ...events]

  if (next.status === 'active') {
    next = swapLeadIfDown(next)
    next.round += 1
    next.phase = 'lead'
    next.energy = { current: next.energy.max, max: next.energy.max }
    telegraph(next, catalog, derive)
    next = drawHand(next)
  }
  return { state: next, events }
}
