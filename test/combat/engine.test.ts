import { describe, it, expect } from 'vitest'
import {
  rollInitiative,
  advanceTurn,
  applyAction,
  checkVictory,
  currentActorId
} from '../../src/shared/combat/engine'
import type { Combatant, Coord, CombatState } from '../../src/shared/combat/types'
import type { RunHook } from '../../src/shared/combat/hooks'

const seq = (vals: number[]): (() => number) => {
  let i = 0
  return () => vals[i++ % vals.length]
}

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
  block: { hp: 10, maxHp: 10, ac: 10, speed: 6, mods: {}, abilities: [], conditions: [], ...block }
})

const state = (combatants: Combatant[], over: Partial<CombatState> = {}): CombatState => ({
  seed: 1,
  rngCursor: 0,
  grid: { w: 5, h: 5, cellFt: 5 },
  combatants,
  initiative: [],
  turnIndex: 0,
  round: 1,
  log: [],
  status: 'active',
  ...over
})

describe('rollInitiative', () => {
  it('orders combatants by roll, highest first', () => {
    const s = rollInitiative(
      state([C('a', 'party', [0, 0]), C('b', 'enemy', [4, 4])]),
      seq([0, 0.95])
    )
    expect(s.initiative).toEqual(['b', 'a'])
    expect(s.turnIndex).toBe(0)
    expect(s.round).toBe(1)
  })
})

describe('advanceTurn', () => {
  it('advances order and bumps the round on wrap', () => {
    const base = state([C('a', 'party', [0, 0]), C('b', 'enemy', [4, 4])], {
      initiative: ['a', 'b']
    })
    const t1 = advanceTurn(base)
    expect(currentActorId(t1)).toBe('b')
    expect(t1.round).toBe(1)
    const t2 = advanceTurn(t1)
    expect(currentActorId(t2)).toBe('a')
    expect(t2.round).toBe(2)
  })

  it('skips downed combatants', () => {
    const s = state(
      [C('a', 'party', [0, 0]), C('b', 'enemy', [1, 1], { hp: 0 }), C('c', 'enemy', [4, 4])],
      { initiative: ['a', 'b', 'c'] }
    )
    expect(currentActorId(advanceTurn(s))).toBe('c')
  })
})

describe('checkVictory', () => {
  it('detects a winner when one side is wiped', () => {
    expect(checkVictory(state([C('a', 'party', [0, 0]), C('e', 'enemy', [1, 1], { hp: 0 })]))).toBe(
      'party'
    )
    expect(checkVictory(state([C('a', 'party', [0, 0], { hp: 0 }), C('e', 'enemy', [1, 1])]))).toBe(
      'enemy'
    )
    expect(checkVictory(state([C('a', 'party', [0, 0]), C('e', 'enemy', [1, 1])]))).toBe('active')
  })
})

describe('applyAction', () => {
  it('applies a legal move and advances the rng cursor', async () => {
    const s = state([C('a', 'party', [0, 0], { speed: 1 })])
    const { state: out } = await applyAction(s, { kind: 'move', actor: 'a', to: [1, 0] })
    expect(out.combatants[0].pos).toEqual([1, 0])
    expect(out.rngCursor).toBe(1)
  })

  it('rejects an illegal move', async () => {
    const s = state([C('a', 'party', [0, 0], { speed: 1 })])
    const { state: out, events } = await applyAction(s, { kind: 'move', actor: 'a', to: [4, 4] })
    expect(out.combatants[0].pos).toEqual([0, 0])
    expect(events.some((e) => e.kind === 'info')).toBe(true)
  })

  it('lets a card override replace native resolution', async () => {
    const base = state([C('a', 'party', [0, 0]), C('e', 'enemy', [1, 1])])
    const custom = state([C('a', 'party', [0, 0]), C('e', 'enemy', [1, 1], { hp: 0 })], {
      round: 99
    })
    const runHook: RunHook = async (name) =>
      name === 'resolveAction'
        ? { state: custom, events: [{ kind: 'info', text: 'card resolved' }] }
        : null
    const { state: out, events } = await applyAction(
      base,
      { kind: 'ability', actor: 'a', abilityId: 'x' },
      { runHook }
    )
    expect(out.round).toBe(99)
    expect(out.status).toBe('party') // checkVictory recomputed over the override's state
    expect(events[0].text).toBe('card resolved')
    expect(out.rngCursor).toBe(1)
  })
})

describe('action economy', () => {
  const strike = {
    id: 'strike',
    name: 'Strike',
    range: 1,
    shape: { kind: 'self' as const },
    toHit: 'STR' as const,
    damage: '1d6'
  }

  it('permits one move per turn', async () => {
    const s = state([C('a', 'party', [0, 0], { speed: 2 })])
    const r1 = await applyAction(s, { kind: 'move', actor: 'a', to: [1, 0] })
    expect(r1.state.turnUsed?.moved).toBe(true)
    const r2 = await applyAction(r1.state, { kind: 'move', actor: 'a', to: [2, 0] })
    expect(r2.state.combatants[0].pos).toEqual([1, 0]) // didn't move again
    expect(r2.events.some((e) => e.kind === 'info')).toBe(true)
  })

  it('spends the attack slot and rejects a second attack', async () => {
    const s = state([
      C('a', 'party', [0, 0], { mods: { STR: 5 } }),
      C('e', 'enemy', [1, 0], { ac: 1 })
    ])
    const action = { kind: 'ability' as const, actor: 'a', abilityId: 'strike', targetIds: ['e'] }
    const r1 = await applyAction(s, action, { abilities: { strike } })
    expect(r1.state.turnUsed?.attack).toBe(true)
    const r2 = await applyAction(r1.state, action, { abilities: { strike } })
    expect(r2.events.some((e) => e.kind === 'info' && /attack/i.test(e.text))).toBe(true)
  })

  it('resets the budget on the next turn', () => {
    const s = state([C('a', 'party', [0, 0]), C('b', 'enemy', [4, 4])], {
      initiative: ['a', 'b'],
      turnUsed: { moved: true, attack: true, action: true }
    })
    const next = advanceTurn(s)
    expect(currentActorId(next)).toBe('b')
    expect(next.turnUsed).toEqual({ moved: false, attack: false, action: false })
  })
})
