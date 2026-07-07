import { z } from 'zod'
import { stripThinking } from '../../../parsers/contentParser'
import { buildGenContext } from '../../generation/genContext'
import { GenContext } from '../../generation/types'
import { providerShape } from '../../generation/providerShape'
import { PresetParameters } from '../../../types/preset'
import { ChatMessage } from '../../promptBuilder'
import { NodeImpl } from '../types'
import { interpolate } from './messageNodes'
import { runLlmCall, LlmCallConfig, llmCallConfigSchema } from './generationNodes'

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
    const count = cfg.lastNFloors ?? 6
    const include = cfg.include ?? 'both'
    const selected = gen.floors.slice(-count)
    const messages: ChatMessage[] = []
    for (const f of selected) {
      if (include !== 'assistant') {
        const user = (f.user_message?.content ?? '').trim()
        if (user) messages.push({ role: 'user', content: user })
      }
      if (include !== 'user') {
        const assistant = stripThinking(f.response?.content ?? '').trim()
        if (assistant) messages.push({ role: 'assistant', content: assistant })
      }
    }
    return { outputs: { messages } }
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
  temperature: z.number().min(0).max(2).optional()
})

type AgentLlmConfig = z.infer<typeof agentLlmConfig>

/** The `{history}` splice marker (a whole-content row REPLACED by the history messages). */
const HISTORY_MARKER = '{history}'

/** Flatten history Messages into a transcript text block (for an inline `{history}` substitution). */
const historyText = (history: ChatMessage[]): string =>
  history
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'System'}: ${m.content}`)
    .join('\n')

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
    { name: 'input', type: 'Any' }
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

    // Build the send messages: interpolate each template row (macros/EJS + the {{input}} slot),
    // splicing the history messages where a row is exactly `{history}`.
    const rows: ChatMessage[] = []
    for (const m of cfg.messages) {
      if (m.content.trim() === HISTORY_MARKER) {
        rows.push(...history)
        continue
      }
      // {{input}} rides the standard {{inN}} slot machinery; {history} inline → transcript text.
      const withHistory = m.content.split(HISTORY_MARKER).join(historyText(history))
      rows.push({ role: m.role, content: interpolate(withHistory, { in1: inputPayload }, gen) })
    }
    const sendMessages = providerShape(gen.settings, rows)

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
    // is pruned (allDead) — a headless agent has no turn to abort, so we simply produce no text.
    if (r === null) return { outputs: {} }
    return { outputs: { text: r.raw } }
  }
}
