import { z } from 'zod'
import { startFromCard } from '../../combatService'
import { startDuelFromCue } from '../../duelService'
import { setChatMode } from '../../chatService'
import { notifyChatModeChanged } from '../../chatEvents'
import { matchAcross } from '../../lorebookService'
import { GenContext } from '../../generation/types'
import { NodeImpl, NodeRunFailure } from '../types'

/**
 * Tool/action nodes (spec §7 phase-2 / §17.7): first-class app actions a workflow branch can
 * take — start an encounter off an LLM decision, or pull lorebook content mid-graph. All are
 * side-branch nodes: gate them behind a Signal (`control.if`/`when` or an LLM judge) so they
 * fire deliberately, and wire their `error` ports if the branch must fail open.
 */

/** The combat-start cue shape the chat path uses (variables.combat_cue); all fields optional. */
type CombatCue = {
  enemies?: string
  map?: string
  roster?: Array<Record<string, unknown>>
} | null

/** Starts a GRID encounter from the world's combat bundle (the same entry the chat's
 *  "enter combat" affordance uses) and switches the session to combat mode — the renderer
 *  follows via the chat-mode-changed push. */
export const toolStartCombat: NodeImpl = {
  type: 'tool.startCombat',
  title: 'Start Combat',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'cue', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'state', type: 'Any' },
    { name: 'error', type: 'Error' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const state = startFromCard(gen.profileId, gen.chatId, (inputs.cue as CombatCue) ?? null)
    setChatMode(gen.profileId, gen.chatId, 'combat')
    return { outputs: { state } }
  }
}

/** Starts an STS DUEL from the party's MVU build + an optional cue roster, and switches the
 *  session to duel mode. Fails (error port) when no duel can be built. */
export const toolStartDuel: NodeImpl = {
  type: 'tool.startDuel',
  title: 'Start Duel',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'cue', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'state', type: 'Any' },
    { name: 'error', type: 'Error' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const state = startDuelFromCue(
      gen.profileId,
      gen.chatId,
      (inputs.cue as { roster?: Array<Record<string, unknown>> } | null) ?? null
    )
    if (!state)
      throw new NodeRunFailure('B', 'duel could not be built from the MVU state / cue', 1)
    // Duel mode is renderer-transient by convention (duel state itself is in-memory per session;
    // main's persisted ChatMode has no 'duel'). Broadcast the switch without a DB write — the
    // same net state the chat's own enter-duel affordance produces.
    notifyChatModeChanged(gen.chatId, 'duel')
    return { outputs: { state } }
  }
}

const searchConfig = z.object({
  /** Cap on returned entries (default 5). */
  max_entries: z.number().int().min(1).max(50).optional()
})

/** Keyword-searches the session's lorebooks with an arbitrary query (a planner's question, a
 *  side job's topic) and returns the matched entries as one text block — the same matcher the
 *  prompt assembly uses, but query-driven instead of chat-scan-driven. */
export const toolLorebookSearch: NodeImpl = {
  type: 'tool.lorebookSearch',
  title: 'Lorebook Search',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'query', type: 'Text' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [{ name: 'block', type: 'Text' }],
  configSchema: searchConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const query = typeof inputs.query === 'string' ? inputs.query : ''
    if (!query.trim()) return { outputs: { block: '' } }
    const max = (node?.config?.max_entries as number | undefined) ?? 5
    const entries = matchAcross(gen.lorebooks, query, Math.random, gen.maxRecursion)
    const block = entries
      .slice(0, max)
      .map((e) => e.content)
      .filter(Boolean)
      .join('\n\n')
    return { outputs: { block } }
  }
}
