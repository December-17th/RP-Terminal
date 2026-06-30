import { describe, it, expect } from 'vitest'
import { createMockDuel, playCardIn, endTurnIn } from '../../src/main/services/duelService'

describe('duelService (mock duel orchestration)', () => {
  it('createMockDuel builds an active duel with a full hand + enemies + a card catalog', () => {
    const rec = createMockDuel()
    expect(rec.state.status).toBe('active')
    expect(rec.state.piles.hand.length).toBe(rec.state.handSize) // hand drawn on start
    expect(rec.state.combatants.some((c) => c.side === 'enemy' && c.block.hp > 0)).toBe(true)
    expect(rec.state.combatants.some((c) => c.side === 'party' && c.block.hp > 0)).toBe(true)
    expect(Object.keys(rec.catalog).length).toBeGreaterThan(0)
  })

  it('playCardIn plays a 普攻 at an enemy: spends energy + moves the card out of hand', () => {
    const rec = createMockDuel()
    // Any party member's 普攻 in the opening hand works — the deckbuilder's shared draw pile
    // doesn't guarantee the lead's own basic attack lands in the first 5 cards (seed + larger
    // skill set can shift it to an ally's 普攻 instead; either is playable on the lead's turn).
    const cardId = rec.state.piles.hand.find((cid) => rec.state.cards[cid].abilityId.endsWith('/普攻'))!
    expect(cardId).toBeDefined()
    const enemy = rec.state.combatants.find((c) => c.side === 'enemy' && c.block.hp > 0)!
    const energyBefore = rec.state.energy.current
    const { record, events } = playCardIn(rec, cardId, [enemy.id])
    expect(record.state.energy.current).toBeLessThan(energyBefore)
    expect(record.state.piles.hand.includes(cardId)).toBe(false) // discarded/exhausted
    expect(events.some((e) => e.kind === 'damage' || e.kind === 'info')).toBe(true)
  })

  it('endTurnIn resolves allies+enemies and either continues (round+1) or ends the duel', () => {
    let rec = createMockDuel()
    const before = rec.state.round
    const { record } = endTurnIn(rec)
    rec = record
    if (rec.state.status === 'active') {
      expect(rec.state.round).toBe(before + 1)
      expect(rec.state.energy.current).toBe(rec.state.energy.max) // energy refreshed
      expect(rec.state.piles.hand.length).toBe(rec.state.handSize) // redrawn
    } else {
      expect(['party', 'enemy']).toContain(rec.state.status)
    }
  })
})
