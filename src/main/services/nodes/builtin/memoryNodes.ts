import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { GenContext } from '../../generation/types'
import { providerShape } from '../../generation/providerShape'
import { PresetParameters } from '../../../types/preset'
import { ChatMessage } from '../../promptBuilder'
import { NodeImpl } from '../types'
import { interpolate } from './messageNodes'
import { runLlmCall, LlmCallConfig, llmCallConfigSchema } from './generationNodes'
import { extractTagAll } from './parseNodes'
import { chatTemplate, recentTranscript, renderTablesBlock, applyTableEdit } from './memoryCore'

/**
 * `memory.maintain` — the ALL-IN-ONE SQL-table memory maintenance node (memory.maintain plan, WP1).
 *
 * Folds the five-node maintenance chain (`history.recent → table.read → agent.llm →
 * parse.extract(TableEdit) → table.apply`) into ONE self-seeding node so the canvas is simple and the
 * run trace shows one node with rich detail (the 数据库-plugin mental model). It REUSES the shared cores
 * (memoryCore: recentTranscript / renderTablesBlock / applyTableEdit; messageNodes.interpolate;
 * generationNodes.runLlmCall; parseNodes.extractTagAll) — no provider/compose/apply logic is duplicated,
 * so the folded node and the fine-grained chain never drift.
 *
 * The per-table maintenance INSTRUCTIONS (each table's note / init / insert / update / delete rules) are
 * NOT this node's config — they live in the bound table template and are rendered by `renderTablesBlock`;
 * the node panel (WP2) edits them back into the template file. The node's own `messages` config is only
 * the SCAFFOLD prompt (the maintainer framing), edited in the Prompt tab.
 *
 * Placeholders in the scaffold rows: `{{tables}}` (canonical) / `{{input}}` (alias, so the proven
 * verbatim maintainer prompt transfers unchanged) → the rendered tables block; `{history}` → the recent
 * transcript (a row that is EXACTLY `{history}` is replaced by the history messages role-preserving; an
 * inline `{history}` is substituted with the flattened transcript text). Table/history text is
 * substituted as DATA (after macros/EJS run on the authored scaffold), never executed.
 *
 * Gated by its `when` Signal (driven by `control.mode.fired` in the seeded default v2); no template
 * bound → silent no-op (read semantics, no wasted model call). Failures throw class-B and route on the
 * `error` port (→ util.log in the default doc). The composed prompt is recorded on the run trace via
 * `debug['prompt (sent)']` so what was sent is inspectable in the Runs tab.
 */

const memoryMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string()
})

const memoryMaintainConfig = llmCallConfigSchema.extend({
  /** The scaffold/maintainer prompt (role-alternating). Routed to the Prompt editor (promptFields). */
  messages: z.array(memoryMessageSchema),
  /** Trailing floors of transcript to include (1..50). Default 6. */
  lastNFloors: z.number().int().min(1).max(50).optional(),
  /** Per-table row cap in the rendered block (keep the newest N). Unset = no cap. */
  max_rows: z.number().int().min(0).optional(),
  /** Include each table's per-op rules in the block (default true). */
  include_rules: z.boolean().optional(),
  /** Advance the table-progress pointer after a successful apply (default TRUE — clears the backlog so
   *  the async trigger + context.trimProcessed work; set false to leave the pointer alone). */
  advance_progress: z.boolean().optional(),
  /** Overrides the preset's temperature for THIS call when set (0..2). */
  temperature: z.number().min(0).max(2).optional()
})

type MemoryMaintainConfig = z.infer<typeof memoryMaintainConfig>

/** The `{history}` splice marker (a whole-content row REPLACED by the history messages). */
const HISTORY_MARKER = '{history}'

/** Flatten history Messages into a transcript text block (for an inline `{history}` substitution) —
 *  same shape agent.llm uses; kept local (a pure 3-line formatter, not lockstep behavior). */
const historyText = (history: ChatMessage[]): string =>
  history
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'System'}: ${m.content}`)
    .join('\n')

export const memoryMaintain: NodeImpl = {
  type: 'memory.maintain',
  title: 'Memory',
  // The scaffold prompt is routed to the dedicated Prompt editor + drives the on-card excerpt.
  promptFields: ['messages'],
  inputs: [{ name: 'when', type: 'Signal' }],
  outputs: [
    { name: 'report', type: 'Text' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: memoryMaintainConfig,
  run: async (ctx, _inputs, node) => {
    const cfg = node.config as MemoryMaintainConfig
    const gen: GenContext = buildGenContext(ctx.profileId!, ctx.chatId!, '')

    // No table memory bound → silent no-op (table.read/table.export read-semantics; do NOT burn a
    // model call when there is nothing to maintain).
    const template = chatTemplate(gen)
    if (!template) return { outputs: {} }

    const { block: tablesBlock } = renderTablesBlock(gen, template, {
      maxRows: cfg.max_rows,
      includeRules: cfg.include_rules
    })
    const history = recentTranscript(gen, { lastNFloors: cfg.lastNFloors })

    // Compose the send messages: splice {history}, run macros/EJS on the authored scaffold, then
    // substitute {{tables}}/{{input}} as DATA (last, so a table block's game-state text can't inject
    // template code — the {{inN}} invariant).
    const rows: ChatMessage[] = []
    for (const m of cfg.messages) {
      if (m.content.trim() === HISTORY_MARKER) {
        rows.push(...history)
        continue
      }
      const withHistory = m.content.split(HISTORY_MARKER).join(historyText(history))
      const interpolated = interpolate(withHistory, {}, gen)
      const withTables = interpolated.split('{{tables}}').join(tablesBlock).split('{{input}}').join(tablesBlock)
      rows.push({ role: m.role, content: withTables })
    }
    const sendMessages = providerShape(gen.settings, rows)

    // Trace-only: the fully composed prompt (b1906ae debug channel) so "did the tables/history reach
    // the model" is inspectable in the Runs tab.
    const promptDebug = {
      'prompt (sent)': sendMessages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')
    }

    const params: PresetParameters = {
      ...gen.preset.parameters,
      ...(cfg.temperature != null ? { temperature: cfg.temperature } : {})
    }
    const callCfg: LlmCallConfig = {
      // A maintenance reply is a side result, never the player-facing stream.
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
    // Abort-with-empty: no reply to parse; the prompt is still traced so the empty result is diagnosable.
    if (r === null) return { outputs: {}, debug: promptDebug }

    // Pull the SQL batch out of the <TableEdit> tag (rule 4: no changes ⇒ an empty tag ⇒ blank sql).
    const sql = extractTagAll(r.raw, 'TableEdit')[0] ?? ''
    if (!sql.trim()) return { outputs: { report: 'no changes' }, debug: promptDebug }

    // Apply via the shared write-core (busy-guard + applySqlBatch + op-log + advance-after-success);
    // a bad batch throws class-B and routes on the `error` port.
    const applied = applyTableEdit(gen, template, sql, {
      advanceProgress: cfg.advance_progress !== false,
      label: 'memory.maintain'
    })
    return {
      outputs: { report: `applied ${applied.applied} statement(s), ${applied.changes} change(s)` },
      debug: promptDebug
    }
  }
}
