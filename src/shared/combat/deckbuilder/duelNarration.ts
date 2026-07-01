// Pure end-of-duel narration prompt (STS mode). Mirrors serialize.ts buildNarrationPrompt for grid
// combat, but reads DuelState (no grid) — outcome + steering + final combatant state + blow-by-blow
// log + the "record consequences in <UpdateVariable>" instruction. Text in, string out.

import type { DuelState } from './deckTypes'
import type { Combatant } from '../types'

const describeDuelCombatant = (c: Combatant): string => {
  const conds = c.block.conditions.length
    ? ` [${c.block.conditions.map((x) => x.id).join(',')}]`
    : ''
  const down = c.block.hp <= 0 ? ' (down)' : ''
  return `- ${c.id} "${c.name}" (${c.side}) HP ${c.block.hp}/${c.block.maxHp}${conds}${down}`
}

/** A compact end-of-duel board description for the narration prompt. */
export const describeDuelState = (state: DuelState): string => {
  const lines = state.combatants.map(describeDuelCombatant).join('\n')
  return `Card duel — round ${state.round}, lead energy ${state.energy.current}/${state.energy.max}.\nCombatants:\n${lines}`
}

/** Prompt the AI to narrate the resolved duel and fold lasting consequences into MVU. `extra` is the
 *  author/user steering prompt (card `narration_prompt` or the user setting). */
export const buildDuelNarrationPrompt = (state: DuelState, extra?: string): string => {
  const log = state.log.map((e) => `- ${e.text}`).join('\n')
  const result =
    state.status === 'party'
      ? 'The party won.'
      : state.status === 'enemy'
        ? 'The party was defeated.'
        : 'The fight broke off unresolved.'
  const lines = [
    'Narrate the following resolved card duel as vivid prose continuing the story.',
    `Outcome: ${result}`
  ]
  if (extra && extra.trim()) lines.push('', extra.trim())
  lines.push(
    '',
    describeDuelState(state),
    '',
    'Blow-by-blow log:',
    log,
    '',
    'After the prose, record the lasting consequences (injuries, deaths, spent resources, loot)',
    'as variable updates in an <UpdateVariable> block, per this world’s schema.'
  )
  return lines.join('\n')
}
