import { z } from 'zod'
import { startFromCard } from '../../combatService'
import { startDuelFromCue } from '../../duelService'
import { setChatMode } from '../../chatService'
import { notifyChatModeChanged } from '../../chatEvents'
import { matchAcross } from '../../lorebookService'
import { Lorebook } from '../../../types/character'
import { GenContext } from '../../generation/types'
import { NodeImpl, NodeRunFailure } from '../types'
import { parseCsvTerms, filterBooksByName } from './lorebookNodes'

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
    if (!state) throw new NodeRunFailure('B', 'duel could not be built from the MVU state / cue', 1)
    // Duel mode is renderer-transient by convention (duel state itself is in-memory per session;
    // main's persisted ChatMode has no 'duel'). Broadcast the switch without a DB write — the
    // same net state the chat's own enter-duel affordance produces.
    notifyChatModeChanged(gen.chatId, 'duel')
    return { outputs: { state } }
  }
}

const searchConfig = z.object({
  /** Cap on returned entries (default 5). */
  max_entries: z.number().int().min(1).max(50).optional(),
  /** Comma-separated substrings, case-insensitive matched against `lorebook.name`; empty (the
   *  default) searches every session book. Narrows the search BEFORE matching, so a
   *  world-progress-style call can skip lorebooks it doesn't need — token savings, not just
   *  result filtering. */
  book_filter: z.string().optional(),
  /** Hard cap on the returned block's length in characters (0/unset = uncapped) — a second
   *  token-saving knob independent of `max_entries` for oversized individual entries. */
  max_chars: z.number().int().min(0).max(100000).optional()
})

/** Keyword-searches the session's lorebooks with an arbitrary query (a planner's question, a
 *  side job's topic) and returns the matched entries as one text block — the same matcher the
 *  prompt assembly uses, but query-driven instead of chat-scan-driven. `book_filter` and
 *  `max_chars` trade completeness for token budget when only a slice of the world's lorebooks
 *  (or a size-capped block) is needed for the side call. */
export const toolLorebookSearch: NodeImpl = {
  type: 'tool.lorebookSearch',
  title: 'Lorebook Search',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'query', type: 'Text' },
    // Optional `Lore` subset (e.g. from lorebook.select): when wired, search THESE books instead
    // of gen.lorebooks — applied BEFORE the config `book_filter` narrows further. Additive.
    { name: 'books', type: 'Lore' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'block', type: 'Text' },
    // The same entries the `block` is built from, as `{ comment, content }` rows (additive).
    { name: 'entries', type: 'Any' }
  ],
  configSchema: searchConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const query = typeof inputs.query === 'string' ? inputs.query : ''
    if (!query.trim()) return { outputs: { block: '', entries: [] } }
    const cfg = (node?.config ?? {}) as z.infer<typeof searchConfig>
    const max = cfg.max_entries ?? 5
    // Wired `books` subset wins over gen.lorebooks; the config book_filter narrows either source.
    const source = (inputs.books as Lorebook[] | undefined) ?? gen.lorebooks
    const books = filterBooksByName(source, parseCsvTerms(cfg.book_filter))
    const matched = matchAcross(books, query, Math.random, gen.maxRecursion).slice(0, max)
    // `entries` mirrors what the `block` is built from: the capped matched entries that actually
    // contributed content (empty-content entries never reach the block, so they're dropped here too).
    const rows = matched
      .filter((e) => Boolean(e.content))
      .map((e) => ({ comment: e.comment ?? '', content: e.content }))
    let block = rows.map((r) => r.content).join('\n\n')
    if (cfg.max_chars && block.length > cfg.max_chars) block = block.slice(0, cfg.max_chars)
    return { outputs: { block, entries: rows } }
  }
}
