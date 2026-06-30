import { describe, it, expect } from 'vitest'
import type { DuelPreview } from '../../src/shared/combat/deckbuilder/preview'

describe('DuelPreview contract', () => {
  it('is structurally usable as the generic preview shape', () => {
    const p: DuelPreview = {
      config: { energyPerTurn: 3, handSize: 5 },
      lead: {
        id: '主角', name: '主角', tier: 2, level: 8,
        resources: { hp: 1820, maxHp: 2340, mp: 320, maxMp: 500, sp: 450, maxSp: 500 },
        modifiers: [{ key: 'attack', label: '攻击', value: 60 }],
        conditions: [{ id: '流血', label: '流血', stacks: 2, turns: 2, kind: 'debuff' }],
        deck: [{
          id: '主角/普攻', name: '普攻', rarityKey: 'common', rarityLabel: '普通',
          kind: 'attack', energyCost: 1, resourceCost: { sp: 5 },
          scalingAttr: '力量', power: 20, effectLines: [], ratingEstimate: 1.0, copies: 4
        }]
      },
      party: []
    }
    expect(p.lead.deck[0].copies).toBe(4)
    expect(p.config.energyPerTurn).toBe(3)
  })
})
