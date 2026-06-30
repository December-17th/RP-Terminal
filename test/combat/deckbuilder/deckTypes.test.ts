import { describe, it, expect } from 'vitest'
import { DEFAULT_DECK_CONFIG, leadCombatant, aliveOnSide } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { DuelState } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { Combatant } from '../../../src/shared/combat/types'

const C = (id: string, side: Combatant['side'], hp = 100): Combatant => ({
  id, side, name: id, pos: [0, 0],
  block: { hp, maxHp: 100, ac: 10, speed: 6, mods: {}, abilities: [], conditions: [] }
})

const duel = (combatants: Combatant[], lead: string): DuelState => ({
  seed: 1, rngCursor: 0, combatants, lead,
  energy: { current: 3, max: 3 },
  piles: { draw: [], hand: [], discard: [], exhaust: [] },
  cards: {}, intents: {}, phase: 'lead', round: 1, status: 'active', log: [], handSize: 5
})

describe('deckTypes selectors', () => {
  it('DEFAULT_DECK_CONFIG has sane defaults', () => {
    expect(DEFAULT_DECK_CONFIG.handSize).toBe(5)
    expect(DEFAULT_DECK_CONFIG.energy).toBe(3)
    expect(DEFAULT_DECK_CONFIG.basics).toEqual({ 普攻: 4, 格挡: 4 })
  })

  it('leadCombatant returns the lead', () => {
    const s = duel([C('主角', 'party'), C('哥布林', 'enemy')], '主角')
    expect(leadCombatant(s)?.id).toBe('主角')
  })

  it('aliveOnSide filters by side and excludes downed (hp 0)', () => {
    const s = duel([C('主角', 'party'), C('苏璃', 'party', 0), C('哥布林', 'enemy')], '主角')
    expect(aliveOnSide(s, 'party').map((c) => c.id)).toEqual(['主角'])
    expect(aliveOnSide(s, 'enemy').map((c) => c.id)).toEqual(['哥布林'])
  })
})
