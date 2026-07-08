import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { GenContext } from '../../generation/types'
import { providerShape } from '../../generation/providerShape'
import { PresetParameters } from '../../../types/preset'
import { ChatMessage } from '../../promptBuilder'
import { Lorebook } from '../../../types/character'
import { matchAcross, getLorebookById } from '../../lorebookService'
import { getLorePicks } from '../../workflowLorePicksStore'
import { NodeImpl } from '../types'
import { interpolate } from './messageNodes'
import { runLlmCall, LlmCallConfig, llmCallConfigSchema } from './generationNodes'
import { recentTranscript } from './memoryCore'

/**
 * Consolidated AGENT nodes (one-canvas rebuild WP6.2; ADR 0011; spec revision 4 §The consolidated
 * node set). These are the CANONICAL lean nodes an author reaches for when building a trigger-rooted
 * agent chain — the memory chains re-ship as five of them: trigger → `history.recent` → `agent.llm`
 * → parser (`parse.extract`) → SQL ops (`table.apply`). The fine-grained legacy nodes
 * (context.history / prompt.messages / llm.sample / …) stay registered so old docs run; these just
 * fold the common "read chat → prompt the model → get its reply" pattern into two nodes with a Signal
 * GATE input so a trigger's `fired` signal starts the chain and a turn run (trigger excluded → gate
 * edge dead) prunes it (the WP6.1 dead-edge mechanism).
 *
 * TWO consolidated node types live here; the other three roles of the five-node chain REUSE existing
 * nodes (reported in the WP6.2 handoff, not re-implemented):
 *   · the PARSER role  = `parse.extract` with `{ mode: 'tag', tag: 'TableEdit' }` (parseNodes.ts) —
 *     it already extracts the reply's tagged SQL block and fires `found`; no `parse.sql` node is
 *     added (reuse, not duplication).
 *   · the SQL-OPS role = `table.apply` (tableNodes.ts), which already gates on `when` and takes the
 *     parser's `first` output as `sql`.
 */

// ── history.recent ───────────────────────────────────────────────────────────────────────────────
//
// The chat-history INPUT of the consolidated chain. It extracts the last N floors down to the two
// things a memory agent cares about — the AI's reply and the player's action — as an alternating
// transcript slice. It SELF-SEEDS its Context off the RunContext (buildGenContext(profileId, chatId))
// exactly as `input.context` does (generationNodes.ts:22-30) and as the WP6.1 handoff prescribes for
// context-reading chain nodes, so a trigger-rooted chain needs NO Context edge from the trigger. The
// slice logic mirrors `context.history` (contextNodes.ts:44-89: assistant content has thinking
// stripped, both sides trimmed, empties skipped) — the SAME distinction of AI reply (`response`) vs
// player action (`user_message`) a floor carries.

/** How a floor distinguishes the AI reply from the player action, and which of the two to keep. The
 *  default 'both' emits the player action THEN the AI reply per floor (the natural transcript order
 *  the summarizer reads). Narrowing to one side is available for agents that only summarize replies. */
const historyRecentConfig = z.object({
  /** Trailing floors to include (1..50). Default 6 (the pack-era `recent` cadence window). */
  lastNFloors: z.number().int().min(1).max(50).optional(),
  /** Which side(s) of each floor to keep: player action + AI reply (both, default), or one side. */
  include: z.enum(['both', 'user', 'assistant']).optional()
})

export const historyRecent: NodeImpl = {
  type: 'history.recent',
  title: 'Recent History',
  inputs: [
    // The Signal gate the trigger's `fired` output drives (WP6.1 pattern — subgraph.call / table.apply
    // / text.template all use this). Wired from the trigger, the chain runs only headlessly; on a turn
    // the trigger is excluded → this edge is dead → the node is gatedOff → the whole chain is pruned.
    { name: 'when', type: 'Signal' }
  ],
  outputs: [{ name: 'messages', type: 'Messages' }],
  configSchema: historyRecentConfig,
  run: (ctx, _inputs, node) => {
    const cfg = node.config as z.infer<typeof historyRecentConfig>
    // Self-seed a fresh committed Context off the RunContext (no pending user action headlessly — a
    // maintenance pass answers no message). Same read input.context does.
    const gen = buildGenContext(ctx.profileId!, ctx.chatId!, '')
    // The transcript slice is shared with memory.maintain (memoryCore.recentTranscript).
    return {
      outputs: {
        messages: recentTranscript(gen, { lastNFloors: cfg.lastNFloors, include: cfg.include })
      }
    }
  }
}

// ── agent.llm ────────────────────────────────────────────────────────────────────────────────────
//
// The GENERIC agent: ONE model call over a customizable role-alternating prompt template, against a
// chosen API preset. It consolidates prompt.messages + llm.sample for the agent pattern:
//   · the prompt template is a list of {system|user|assistant} rows whose content is interpolated
//     with the same macro/EJS engine the authoring nodes use (interpolate, messageNodes.ts) — so
//     `{{user}}`/`{{char}}`/`{{getvar}}`/EJS all work — plus two agent-specific placeholders:
//       – `{{input}}`  : the generic `input` port payload (a non-chat upstream value; stringified).
//       – `{history}`  : SPLICED with the `history` Messages input. A row whose ENTIRE content is
//                        `{history}` is REPLACED by the history messages, each as its own message
//                        (role-preserving — the natural place a summarizer wants the transcript). An
//                        inline `{history}` inside other text is substituted with the flattened
//                        transcript text instead (a fallback for authors who want it embedded).
//   · api_preset_id selects the connection exactly as llm.sample does (same withPreset swap, shared
//     via runLlmCall — generationNodes.ts). `temperature` overrides the preset's when set.
//   · it calls the SAME provider core as llm.sample (runLlmCall) — no duplicated streaming/abort/
//     retry. Default `stream:false` (an agent's reply is a side result, not the player stream).
// Output: `text` (the model reply). It self-seeds its Context off the RunContext so, like
// history.recent, it needs no Context edge from the trigger.

const agentMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string()
})

/** agent.llm config = the role-alternating prompt template + the shared LLM-call knobs + an optional
 *  temperature override. `stream` defaults to false here (llmCallConfigSchema leaves it optional). */
const agentLlmConfig = llmCallConfigSchema.extend({
  messages: z.array(agentMessageSchema),
  /** Overrides the preset's temperature for THIS call when set (0..2). Unset = the preset's own. */
  temperature: z.number().min(0).max(2).optional(),
  /** Agent & memory UX (WP-H; spec §7): how lore reaches this call WHEN the `lore` input is unwired.
   *  'main' (default) = the STANDARD worldinfo matching over the agent's history against the world's
   *  active lorebooks; 'custom' = exactly the per-world picked entries (workflowLorePicksStore),
   *  falling back to 'main' while no picks exist yet. A wired `lore` input beats either. */
  lorebook: z.enum(['main', 'custom']).optional()
})

type AgentLlmConfig = z.infer<typeof agentLlmConfig>

/** The `{history}` splice marker (a whole-content row REPLACED by the history messages). */
const HISTORY_MARKER = '{history}'

/** The `{{lore}}` injection placeholder (spec §7.3): substituted with the resolved lore block in any
 *  template row; when NO row carries it, a non-empty block is appended as a trailing system row. */
const LORE_MARKER = '{{lore}}'

/** Flatten history Messages into a transcript text block (for an inline `{history}` substitution). */
const historyText = (history: ChatMessage[]): string =>
  history
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'System'}: ${m.content}`)
    .join('\n')

/** Flatten a Lore wire's books into a lore block — `lorebook.entries` semantics (lorebookNodes.ts:
 *  110-129): enabled entries' raw contents joined by blank lines, NO keyword scan (the wire was
 *  hand-picked upstream). */
const loreBlockFromBooks = (books: Lorebook[]): string =>
  books
    .flatMap((lb) => lb.entries)
    .filter((e) => e.enabled !== false)
    .map((e) => e.content)
    .filter(Boolean)
    .join('\n\n')

/** Resolve this call's lore block per the spec §7 order — wire wins, then config:
 *   1. `lore` input WIRED (per the doc, node.wiredInputs — the WP-B seam) ⇒ the wire's books,
 *      flattened. A wired-but-dead edge (its feeder gated off this run) yields an EMPTY block —
 *      the author's chosen source produced nothing; we do NOT silently fall back to matching.
 *   2. config 'custom' with stored picks for (chat.character_id, docId, nodeId) ⇒ exactly those
 *      entries, `(book, comment)` identity, missing picks skipped fail-soft (plan §0.4 comment
 *      fallback — our entries carry no uid).
 *   3. else ('main', or 'custom' with no picks yet) ⇒ the STANDARD matching the narrator's assemble
 *      uses — the same `matchAcross` core over the same active books + recursion cap
 *      (assemble.ts:78-106 matchWorldInfo = matchAcross + an FSM-mode cache; a side call must not
 *      read/poison that cache, so we call the shared core directly) — scanned over the agent's
 *      `history` input (spec §7.2), falling back to the narrator's own scan window (gen.scanText)
 *      when no history is wired/live.
 *  Exported for tests. */
export const resolveAgentLore = (
  gen: GenContext,
  cfg: { lorebook?: 'main' | 'custom' },
  history: ChatMessage[],
  loreInput: { wired: boolean; books: Lorebook[] },
  ids: { profileId: string; docId: string; nodeId: string }
): string => {
  if (loreInput.wired) return loreBlockFromBooks(loreInput.books)

  if (cfg.lorebook === 'custom') {
    const picks = getLorePicks(ids.profileId, gen.chat.character_id, ids.docId, ids.nodeId)
    if (picks.length > 0) {
      // Group picks per book so each book is read once; resolve by (book, comment), skip missing.
      const byBook = new Map<string, Set<string>>()
      for (const p of picks) {
        const set = byBook.get(p.book)
        if (set) set.add(p.comment)
        else byBook.set(p.book, new Set([p.comment]))
      }
      const contents: string[] = []
      for (const [bookId, comments] of byBook) {
        const book = getLorebookById(ids.profileId, bookId)
        if (!book) continue
        for (const e of book.entries) {
          if (e.enabled === false) continue
          if (comments.has(e.comment ?? '')) contents.push(e.content)
        }
      }
      return contents.filter(Boolean).join('\n\n')
    }
    // No picks yet for this world ⇒ fall through to standard matching (spec §7.2 fallback).
  }

  const scan = history.length > 0 ? historyText(history) : gen.scanText
  const matched = matchAcross(gen.lorebooks, scan, Math.random, gen.maxRecursion)
  return matched
    .map((e) => e.content)
    .filter(Boolean)
    .join('\n\n')
}

export const agentLlm: NodeImpl = {
  type: 'agent.llm',
  title: 'Agent',
  // Agent & memory UX (WP-A; spec §1): `messages` is the authored prompt — the editor routes it to the
  // dedicated Prompt editor (not the generic objectArray control) and derives the on-card excerpt.
  promptFields: ['messages'],
  inputs: [
    { name: 'when', type: 'Signal' },
    { name: 'history', type: 'Messages' },
    // A generic non-chat payload the template can splice via {{input}} (e.g. a table.read block).
    { name: 'input', type: 'Any' },
    // WP-H (spec §7): a hand-picked lorebook slice (lorebook.select). Wired, it BEATS the `lorebook`
    // config — the resolution order is wire > custom picks > standard matching (resolveAgentLore).
    { name: 'lore', type: 'Lore' }
  ],
  outputs: [
    { name: 'text', type: 'Text' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: agentLlmConfig,
  run: async (ctx, inputs, node) => {
    const cfg = node.config as AgentLlmConfig
    const gen: GenContext = buildGenContext(ctx.profileId!, ctx.chatId!, '')
    const history = (inputs.history as ChatMessage[] | undefined) ?? []
    const inputPayload = inputs.input

    // WP-H: resolve this call's lore block (wire > per-world picks > standard matching). Wired-ness
    // comes from the doc (node.wiredInputs, the WP-B seam) so a wired-but-gated lore feeder yields
    // an empty block instead of silently falling back to matching.
    const loreBlock = resolveAgentLore(
      gen,
      cfg,
      history,
      {
        wired: node.wiredInputs?.includes('lore') ?? false,
        books: (inputs.lore as Lorebook[] | undefined) ?? []
      },
      { profileId: ctx.profileId!, docId: ctx.workflowId ?? '', nodeId: node.id }
    )
    const hasLoreMarker = cfg.messages.some((m) => m.content.includes(LORE_MARKER))

    // Build the send messages: interpolate each template row (macros/EJS + the {{input}} slot),
    // splicing the history messages where a row is exactly `{history}`, and substituting `{{lore}}`
    // (spec §7.3 — an empty block substitutes as '', fail-soft).
    const rows: ChatMessage[] = []
    for (const m of cfg.messages) {
      if (m.content.trim() === HISTORY_MARKER) {
        rows.push(...history)
        continue
      }
      // {{input}} rides interpolate's dedicated data slot (substituted LAST, like {{inN}}, so a table
      // block's game-state text can't inject template code); `in1` kept as a back-compat alias for the
      // same payload. {history} inline → transcript text. {{lore}} is substituted BEFORE interpolate so
      // the macro engine never sees the marker.
      const withHistory = m.content.split(HISTORY_MARKER).join(historyText(history))
      const withLore = withHistory.split(LORE_MARKER).join(loreBlock)
      rows.push({
        role: m.role,
        content: interpolate(withLore, { in1: inputPayload, input: inputPayload }, gen)
      })
    }
    // No `{{lore}}` row anywhere + a non-empty block ⇒ appended system row (spec §7.3). Empty ⇒ none.
    if (!hasLoreMarker && loreBlock) rows.push({ role: 'system', content: loreBlock })
    const sendMessages = providerShape(gen.settings, rows)

    // Debug (trace-only): the FULLY composed prompt this call actually sends — interpolated rows with
    // {{input}}/{history}/{{lore}} spliced, provider-shaped. Surfaces in the run drawer's Runs tab so
    // "did the table block / history reach the model" is inspectable without adding a graph port.
    const promptDebug = { 'prompt (sent)': sendMessages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n') }

    // Params from the preset (temperature override when configured). No FSM cap here — an agent call
    // is a side call, budgeted by its own preset.
    const params: PresetParameters = {
      ...gen.preset.parameters,
      ...(cfg.temperature != null ? { temperature: cfg.temperature } : {})
    }

    const callCfg: LlmCallConfig = {
      // Default to non-streaming: an agent reply is a side result, never the player-facing stream.
      stream: cfg.stream === true,
      ...(cfg.api_preset_id ? { api_preset_id: cfg.api_preset_id } : {}),
      ...(cfg.retries != null ? { retries: cfg.retries } : {}),
      ...(cfg.retry_delay_s != null ? { retry_delay_s: cfg.retry_delay_s } : {}),
      ...(cfg.fallback_preset_id ? { fallback_preset_id: cfg.fallback_preset_id } : {}),
      ...(cfg.validator ? { validator: cfg.validator } : {}),
      ...(cfg.validator_pattern ? { validator_pattern: cfg.validator_pattern } : {}),
      ...(cfg.validator_retries != null ? { validator_retries: cfg.validator_retries } : {}),
      ...(cfg.corrective_nudge ? { corrective_nudge: cfg.corrective_nudge } : {})
    }

    const r = await runLlmCall(ctx, gen, sendMessages, params, callCfg)
    // Abort-with-empty: nothing to emit; the chain's downstream (parser) sees a dead `text` edge and
    // is pruned (allDead) — a headless agent has no turn to abort, so we simply produce no text. The
    // composed prompt is still traced (the call DID go out) so an empty result is diagnosable.
    if (r === null) return { outputs: {}, debug: promptDebug }
    return { outputs: { text: r.raw }, debug: promptDebug }
  }
}
