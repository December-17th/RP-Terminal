// Combat core — CombatState ⇄ AI prompt/result serialization (Track Combat / P6).
//
// Pure module. Turns the engine's state/log into the prompts the AI sees (mid-fight
// adjudication of out-of-system actions; end-of-combat narration; enemy decisions)
// and parses the AI's structured replies back into ops the engine applies. The model
// call itself lives in main (combatService → generateRaw); this layer is just text in,
// ops out — so it's fully unit-testable. See docs/combat-system-design.md §3/§6.

import { applyDamageAmount } from './resolver'
import type { Action, Combatant, CombatEvent, CombatState, Coord } from './types'

/** Ops the AI may return to mutate combat state (adjudication of a freeform action). */
export type ResultOp =
  | { op: 'damage'; target: string; amount: number; type?: string }
  | { op: 'heal'; target: string; amount: number }
  | { op: 'move'; target: string; to: Coord }
  | { op: 'condition'; target: string; id: string; duration?: number }

const describeCombatant = (c: Combatant): string => {
  const conds = c.block.conditions.length
    ? ` [${c.block.conditions.map((x) => x.id).join(',')}]`
    : ''
  const down = c.block.hp <= 0 ? ' (down)' : ''
  return `- ${c.id} "${c.name}" (${c.side}) at (${c.pos[0]},${c.pos[1]}) HP ${c.block.hp}/${c.block.maxHp}${conds}${down}`
}

/** A compact battlefield description shared by the prompts. */
export const describeState = (state: CombatState): string => {
  const lines = state.combatants.map(describeCombatant).join('\n')
  return `Grid ${state.grid.w}x${state.grid.h} (cells). Round ${state.round}.\nCombatants:\n${lines}`
}

/** Prompt the AI to adjudicate a freeform player action and reply with result ops. */
export const buildAdjudicationPrompt = (
  state: CombatState,
  actorId: string,
  prose: string,
  extra?: string
): string => {
  const actor = state.combatants.find((c) => c.id === actorId)
  const who = actor ? `${actor.name} (${actor.id})` : actorId
  const lines = [
    'You are the combat referee. The player attempts an action the tactical system cannot model.',
    'Resolve it fairly given the battlefield, then reply with ONLY an <rpt-combat-result> block.'
  ]
  if (extra && extra.trim()) lines.push('', extra.trim())
  lines.push(
    '',
    describeState(state),
    '',
    `Acting combatant: ${who}.`,
    `Attempted action: "${prose}"`,
    '',
    'Reply EXACTLY in this form (JSON inside the tag): one short narration sentence, the ops, and set',
    '"end" to true if this action concludes or escapes the fight (the player leaves combat):',
    '<rpt-combat-result>',
    '{ "narration": "…", "ops": [ {"op":"damage","target":"<id>","amount":0,"type":"fire"}, {"op":"move","target":"<id>","to":[0,0]}, {"op":"condition","target":"<id>","id":"prone","duration":1}, {"op":"heal","target":"<id>","amount":0} ], "end": false }',
    '</rpt-combat-result>'
  )
  return lines.join('\n')
}

/** Prompt the AI to narrate the resolved fight and fold lasting consequences into MVU.
 *  `extra` is the author/user steering prompt (card `narration_prompt` or the user setting),
 *  inserted as guidance after the outcome line. */
export const buildNarrationPrompt = (state: CombatState, extra?: string): string => {
  const log = state.log.map((e) => `- ${e.text}`).join('\n')
  const result =
    state.status === 'party'
      ? 'The party won.'
      : state.status === 'enemy'
        ? 'The party was defeated.'
        : 'The fight broke off unresolved.'
  const lines = [
    'Narrate the following resolved combat as vivid prose continuing the story.',
    `Outcome: ${result}`
  ]
  if (extra && extra.trim()) lines.push('', extra.trim())
  lines.push(
    '',
    describeState(state),
    '',
    'Blow-by-blow log:',
    log,
    '',
    'After the prose, record the lasting consequences (injuries, deaths, spent resources, loot)',
    'as variable updates in an <UpdateVariable> block, per this world’s schema.'
  )
  return lines.join('\n')
}

/** Prompt the AI to choose one enemy's action from the legal set (the `ai` controller). */
export const buildEnemyPrompt = (state: CombatState, enemyId: string): string => {
  const enemy = state.combatants.find((c) => c.id === enemyId)
  const abilities = enemy ? enemy.block.abilities.join(', ') : ''
  return [
    `Choose the best action for enemy ${enemyId} this turn. Reply with ONLY an <rpt-action> block.`,
    '',
    describeState(state),
    '',
    `Enemy ${enemyId} abilities: ${abilities}.`,
    'Form: <rpt-action>{ "kind":"ability"|"move"|"end", "abilityId":"…", "targetIds":["…"], "to":[x,y] }</rpt-action>'
  ].join('\n')
}

const extractTag = (text: string, tag: string): string | null => {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? m[1].trim() : null
}

/** Parse an `<rpt-combat-result>` block into a narration + normalized ops + an `end`
 *  flag (the AI concluded/escaped the fight → exit combat). Tolerant of malformed input. */
export const parseCombatResult = (
  text: string
): { narration: string; ops: ResultOp[]; end: boolean } => {
  const body = extractTag(text, 'rpt-combat-result')
  if (!body) return { narration: '', ops: [], end: false }
  try {
    const obj = JSON.parse(body)
    return {
      narration: typeof obj.narration === 'string' ? obj.narration : '',
      ops: Array.isArray(obj.ops) ? (obj.ops as ResultOp[]) : [],
      end: obj.end === true
    }
  } catch {
    return { narration: '', ops: [], end: false }
  }
}

/** Parse an `<rpt-action>` block into an Action for the given actor (tolerant). */
export const parseEnemyAction = (text: string, enemyId: string): Action | null => {
  const body = extractTag(text, 'rpt-action')
  if (!body) return null
  try {
    const o = JSON.parse(body)
    if (o.kind !== 'ability' && o.kind !== 'move' && o.kind !== 'end') return null
    return {
      kind: o.kind,
      actor: enemyId,
      abilityId: o.abilityId,
      targetIds: Array.isArray(o.targetIds) ? o.targetIds : undefined,
      targetCell: Array.isArray(o.targetCell) ? o.targetCell : undefined,
      to: Array.isArray(o.to) ? o.to : undefined
    }
  } catch {
    return null
  }
}

/** Apply AI-adjudicated result ops to a (mutable) state, returning log events. */
export const applyCombatResult = (state: CombatState, ops: ResultOp[]): CombatEvent[] => {
  const events: CombatEvent[] = []
  const find = (id: string): Combatant | undefined => state.combatants.find((c) => c.id === id)
  for (const op of ops) {
    const target = find(op.target)
    if (!target) continue
    if (op.op === 'damage') {
      const dealt = applyDamageAmount(target, Number(op.amount) || 0, op.type)
      events.push({
        kind: 'damage',
        text: `${target.name} takes ${dealt} — HP ${target.block.hp}/${target.block.maxHp}.`,
        delta: { target: target.id, damage: dealt, hp: target.block.hp }
      })
      if (target.block.hp <= 0)
        events.push({
          kind: 'death',
          text: `${target.name} is down!`,
          delta: { target: target.id, dead: true }
        })
    } else if (op.op === 'heal') {
      const before = target.block.hp
      target.block.hp = Math.min(target.block.maxHp, target.block.hp + (Number(op.amount) || 0))
      events.push({
        kind: 'damage',
        text: `${target.name} recovers ${target.block.hp - before} — HP ${target.block.hp}/${target.block.maxHp}.`,
        delta: { target: target.id, hp: target.block.hp }
      })
    } else if (op.op === 'move') {
      target.pos = [op.to[0], op.to[1]]
      events.push({
        kind: 'move',
        text: `${target.name} moves to (${op.to[0]},${op.to[1]}).`,
        delta: { target: target.id, to: target.pos }
      })
    } else if (op.op === 'condition') {
      if (!target.block.conditions.some((c) => c.id === op.id))
        target.block.conditions.push({ id: op.id, duration: op.duration ?? 1 })
      events.push({
        kind: 'condition',
        text: `${target.name}: ${op.id}.`,
        delta: { target: target.id, conditions: [op.id] }
      })
    }
  }
  return events
}
