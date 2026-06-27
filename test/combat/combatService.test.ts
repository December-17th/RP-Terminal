import { describe, it, expect } from 'vitest'
import {
  createEncounter,
  playerAction,
  enemyTurn,
  summarizeOutcome,
  makeRunHook,
  mockEncounterSetup
} from '../../src/main/services/combatService'
import type { AbilityDef, Combatant, Coord } from '../../src/shared/combat/types'

const C = (
  id: string,
  side: Combatant['side'],
  pos: Coord,
  block: Partial<Combatant['block']> = {}
): Combatant => ({
  id,
  side,
  name: id,
  pos,
  block: {
    hp: 10,
    maxHp: 10,
    ac: 10,
    speed: 6,
    mods: {},
    abilities: ['slash'],
    conditions: [],
    ...block
  }
})

const slash: AbilityDef = {
  id: 'slash',
  name: 'Slash',
  range: 1,
  shape: { kind: 'self' },
  toHit: 'STR',
  damage: '1d6+STR',
  damageType: 'slashing'
}

const grid = { w: 5, h: 5, cellFt: 5 }

describe('createEncounter', () => {
  it('rolls initiative and opens the log', () => {
    const rec = createEncounter({
      seed: 1,
      grid,
      combatants: [C('a', 'party', [0, 0]), C('e', 'enemy', [4, 4])]
    })
    expect(rec.state.initiative).toHaveLength(2)
    expect(rec.state.status).toBe('active')
    expect(rec.state.log[0].text).toContain('Combat begins')
  })
})

describe('playerAction', () => {
  it('applies a native move', async () => {
    const rec = createEncounter({
      seed: 1,
      grid,
      combatants: [C('a', 'party', [0, 0], { speed: 2 })]
    })
    const { record, events } = await playerAction(rec, { kind: 'move', actor: 'a', to: [1, 1] })
    expect(record.state.combatants[0].pos).toEqual([1, 1])
    expect(events.some((e) => e.kind === 'move')).toBe(true)
  })

  it('routes through a card-authored resolveAction hook (sandboxed)', async () => {
    const SCRIPT =
      "return { state: Object.assign({}, input.state, { round: 99 }), events: [{ kind: 'info', text: 'hook' }] }"
    const rec = createEncounter({
      seed: 1,
      grid,
      combatants: [C('a', 'party', [0, 0]), C('e', 'enemy', [1, 1])],
      hooks: { resolveAction: SCRIPT }
    })
    const { record, events } = await playerAction(rec, {
      kind: 'ability',
      actor: 'a',
      abilityId: 'x'
    })
    expect(record.state.round).toBe(99)
    expect(events[0].text).toBe('hook')
  })
})

describe('enemyTurn', () => {
  it('picks a weighted action and advances the turn', async () => {
    const rec = createEncounter({
      seed: 1,
      grid,
      combatants: [C('e', 'enemy', [1, 1], { mods: { STR: 3 } }), C('p', 'party', [1, 2])],
      abilities: { slash }
    })
    rec.state.initiative = ['e', 'p']
    rec.state.turnIndex = 0
    const { record, events } = await enemyTurn(rec)
    expect(events.some((e) => e.kind === 'attack')).toBe(true)
    expect(record.state.initiative[record.state.turnIndex]).toBe('p')
  })
})

describe('makeRunHook', () => {
  it('runs a defined hook in the sandbox and returns its result', async () => {
    const dummy = createEncounter({ seed: 1, grid, combatants: [C('a', 'party', [0, 0])] }).state
    const run = makeRunHook({
      resolveAction: 'return { state: Object.assign({}, input.state, { round: 7 }), events: [] }'
    })
    const r = await run('resolveAction', { state: dummy, action: { kind: 'end', actor: 'a' } }, 1)
    expect(r?.state?.round).toBe(7)
  })

  it('returns null for an undefined hook', async () => {
    const dummy = createEncounter({ seed: 1, grid, combatants: [C('a', 'party', [0, 0])] }).state
    const run = makeRunHook({})
    expect(await run('onTurnStart', { state: dummy }, 1)).toBeNull()
  })
})

describe('mockEncounterSetup', () => {
  it('builds the debug encounter: 2 party, 3 weighted goblins, abilities, a walled map', () => {
    const s = mockEncounterSetup()
    expect(s.grid).toMatchObject({ w: 10, h: 8 })
    expect(s.combatants.filter((c) => c.side === 'party').map((c) => c.id)).toEqual([
      'maeve',
      'kai'
    ])
    const goblins = s.combatants.filter((c) => c.side === 'enemy')
    expect(goblins).toHaveLength(3)
    expect(goblins.every((g) => g.controller === 'weighted')).toBe(true)
    expect(Object.keys(s.abilities ?? {}).sort()).toEqual(['bolt', 'fireball', 'strike'])
    expect(s.grid.tiles?.[3 * 10 + 5].passable).toBe(false)
  })
})

describe('built-in system resolver injection (BP4)', () => {
  const derive = {
    tier_coefficient: { '2': 2.8 },
    rating_tiers: [
      [20, 1.3],
      [11, 1.0],
      [4, 0.3],
      [0, 0]
    ] as [number, number][],
    attr_mitigation: { 物理: 0.0025 },
    defense_constant: 2000
  }
  const pc = (
    id: string,
    side: Combatant['side'],
    pos: Coord,
    attrs: Record<string, number>,
    hp: number
  ): Combatant => ({
    id,
    side,
    name: id,
    pos,
    block: {
      hp,
      maxHp: hp,
      ac: 10,
      speed: 6,
      mods: { DEX: attrs.敏捷 },
      abilities: [`${id}/普攻`],
      conditions: []
    },
    ext: {
      system: 'poemD20',
      attrs,
      tier: 2,
      equip: { 武器攻击: 50, 防御: 50, 命中: 0, 闪避: 0, DR: 0 },
      passives: []
    }
  })
  const punch = (id: string): AbilityDef => ({
    id: `${id}/普攻`,
    name: '普攻',
    range: 1,
    shape: { kind: 'self' },
    toHit: null,
    cost: 'attack',
    ext: { 威力: 20, 关联属性: '力量' }
  })

  it('routes ability resolution to the poemD20 战斗协议 resolver (card-formula, not native)', async () => {
    const a = pc('a', 'party', [0, 0], { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, 800)
    const e = pc('e', 'enemy', [1, 0], { 力量: 3, 敏捷: 2, 体质: 4, 智力: 1, 精神: 2 }, 500)
    const rec = createEncounter({
      seed: 1,
      grid,
      combatants: [a, e],
      abilities: { 'a/普攻': punch('a'), 'e/普攻': punch('e') },
      system: 'poemD20',
      derive
    })
    const { events } = await playerAction(rec, {
      kind: 'ability',
      actor: 'a',
      abilityId: 'a/普攻',
      targetIds: ['e']
    })
    // A toHit:null / no-damage ability resolves to nothing natively; only the 战斗协议 resolver
    // emits a 命中/失手 outcome — so a miss-or-damage event proves the resolver was injected.
    expect(events.some((ev) => ev.kind === 'miss' || ev.kind === 'damage')).toBe(true)
  })

  it('falls through to native for moves (resolver returns null)', async () => {
    const a = pc('a', 'party', [0, 0], { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, 800)
    const rec = createEncounter({ seed: 1, grid, combatants: [a], system: 'poemD20', derive })
    const { record } = await playerAction(rec, { kind: 'move', actor: 'a', to: [1, 0] })
    expect(record.state.combatants[0].pos).toEqual([1, 0])
  })
})

describe('summarizeOutcome', () => {
  it('reports the winner and per-combatant survival', () => {
    const s = createEncounter({
      seed: 1,
      grid,
      combatants: [C('p', 'party', [0, 0]), C('e', 'enemy', [2, 2], { hp: 0 })]
    }).state
    s.status = 'party'
    const o = summarizeOutcome(s)
    expect(o.winner).toBe('party')
    expect(o.combatants.find((c) => c.id === 'e')?.alive).toBe(false)
    expect(o.combatants.find((c) => c.id === 'p')?.alive).toBe(true)
  })
})
