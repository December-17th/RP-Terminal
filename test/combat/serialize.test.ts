import { describe, it, expect } from 'vitest'
import {
  buildAdjudicationPrompt,
  buildNarrationPrompt,
  buildEnemyPrompt,
  parseCombatResult,
  parseEnemyAction,
  applyCombatResult
} from '../../src/shared/combat/serialize'
import { parseCombatStart } from '../../src/main/parsers/contentParser'
import type { Combatant, Coord, CombatState } from '../../src/shared/combat/types'

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

const state = (combatants: Combatant[]): CombatState => ({
  seed: 1,
  rngCursor: 0,
  grid: { w: 6, h: 6, cellFt: 5 },
  combatants,
  initiative: combatants.map((c) => c.id),
  turnIndex: 0,
  round: 2,
  log: [{ kind: 'attack', text: 'Maeve swings.' }],
  status: 'active'
})

describe('prompt builders', () => {
  it('adjudication prompt names the actor, the action, and the result tag', () => {
    const s = state([C('hero', 'party', [0, 0]), C('g1', 'enemy', [1, 0])])
    const p = buildAdjudicationPrompt(s, 'hero', 'swing on the chandelier')
    expect(p).toContain('swing on the chandelier')
    expect(p).toContain('hero')
    expect(p).toContain('<rpt-combat-result>')
  })
  it('narration prompt includes the outcome, log, and an UpdateVariable instruction', () => {
    const s = { ...state([C('hero', 'party', [0, 0])]), status: 'party' as const }
    const p = buildNarrationPrompt(s)
    expect(p).toContain('Maeve swings.')
    expect(p).toContain('party won')
    expect(p).toContain('<UpdateVariable>')
  })
  it('enemy prompt asks for an rpt-action', () => {
    const s = state([C('g1', 'enemy', [0, 0]), C('hero', 'party', [1, 0])])
    expect(buildEnemyPrompt(s, 'g1')).toContain('<rpt-action>')
  })
})

describe('parseCombatResult', () => {
  it('parses narration + ops from the tagged block', () => {
    const r = parseCombatResult(
      'sure: <rpt-combat-result>{ "narration": "Boom.", "ops": [ {"op":"damage","target":"g1","amount":5} ] }</rpt-combat-result>'
    )
    expect(r.narration).toBe('Boom.')
    expect(r.ops).toHaveLength(1)
  })
  it('is tolerant of a missing / unparseable block', () => {
    expect(parseCombatResult('no tag here')).toEqual({ narration: '', ops: [] })
    expect(parseCombatResult('<rpt-combat-result>not json</rpt-combat-result>')).toEqual({
      narration: '',
      ops: []
    })
  })
})

describe('parseEnemyAction', () => {
  it('parses an ability action bound to the enemy', () => {
    const a = parseEnemyAction(
      '<rpt-action>{ "kind": "ability", "abilityId": "slash", "targetIds": ["hero"] }</rpt-action>',
      'g1'
    )
    expect(a).toEqual({
      kind: 'ability',
      actor: 'g1',
      abilityId: 'slash',
      targetIds: ['hero'],
      targetCell: undefined,
      to: undefined
    })
  })
  it('returns null for a missing or invalid action', () => {
    expect(parseEnemyAction('nope', 'g1')).toBeNull()
    expect(parseEnemyAction('<rpt-action>{ "kind": "wat" }</rpt-action>', 'g1')).toBeNull()
  })
})

describe('applyCombatResult', () => {
  it('applies damage (with death), heal, move, and condition', () => {
    const s = state([
      C('g1', 'enemy', [1, 0], { hp: 8, maxHp: 8 }),
      C('hero', 'party', [0, 0], { hp: 4 })
    ])
    const events = applyCombatResult(s, [
      { op: 'damage', target: 'g1', amount: 100 },
      { op: 'heal', target: 'hero', amount: 3 },
      { op: 'move', target: 'hero', to: [2, 2] },
      { op: 'condition', target: 'g1', id: 'prone', duration: 1 }
    ])
    const g1 = s.combatants[0]
    const hero = s.combatants[1]
    expect(g1.block.hp).toBe(0)
    expect(events.some((e) => e.kind === 'death')).toBe(true)
    expect(hero.block.hp).toBe(7)
    expect(hero.pos).toEqual([2, 2])
    expect(g1.block.conditions.map((c) => c.id)).toContain('prone')
  })
})

describe('parseCombatStart', () => {
  it('extracts the cue and strips the tag', () => {
    const { text, cue } = parseCombatStart(
      'A horde appears! <rpt-combat-start enemies="goblin x3" map="forest"></rpt-combat-start> Ready?'
    )
    expect(cue).toEqual({ enemies: 'goblin x3', map: 'forest' })
    expect(text).not.toContain('<rpt-combat-start')
    expect(text).toContain('A horde appears!')
  })
  it('returns a null cue and untouched text when absent', () => {
    expect(parseCombatStart('Just talking.')).toEqual({ text: 'Just talking.', cue: null })
  })
})
