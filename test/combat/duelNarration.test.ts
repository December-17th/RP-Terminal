import { describe, it, expect } from 'vitest'
import { buildDuelNarrationPrompt } from '../../src/shared/combat/deckbuilder'
import type { DuelState } from '../../src/shared/combat/deckbuilder'

const base = (status: DuelState['status']): DuelState => ({
  seed: 1, rngCursor: 0, lead: 'p1',
  combatants: [
    { id: 'p1', name: '主角', side: 'party', pos: [0, 0], block: { hp: 800, maxHp: 1400, conditions: [], abilities: [] } } as any,
    { id: 'e1', name: '哥布林', side: 'enemy', pos: [0, 0], block: { hp: 0, maxHp: 120, conditions: [], abilities: [] } } as any
  ],
  energy: { current: 1, max: 3 },
  piles: { draw: [], hand: [], discard: [], exhaust: [] },
  cards: {}, intents: {}, phase: 'lead', round: 4, status, log: [{ kind: 'info', text: '主角 击败 哥布林' } as any], handSize: 5
})

describe('buildDuelNarrationPrompt', () => {
  it('maps party win / enemy win / active to the right outcome line', () => {
    expect(buildDuelNarrationPrompt(base('party'))).toContain('The party won.')
    expect(buildDuelNarrationPrompt(base('enemy'))).toContain('The party was defeated.')
    expect(buildDuelNarrationPrompt(base('active'))).toContain('broke off unresolved')
  })
  it('includes the blow-by-blow log and the UpdateVariable instruction', () => {
    const p = buildDuelNarrationPrompt(base('party'))
    expect(p).toContain('主角 击败 哥布林')
    expect(p).toContain('<UpdateVariable>')
  })
  it('inserts the steering prompt when provided', () => {
    expect(buildDuelNarrationPrompt(base('party'), 'Keep it grim.')).toContain('Keep it grim.')
  })
})
