import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { GenContext } from '../../generation/types'
import { providerShape } from '../../generation/providerShape'
import { ChatMessage } from '../../promptBuilder'
import { TableTemplate } from '../../../types/tableTemplate'
import { NodeImpl } from '../types'
import { interpolate } from './messageNodes'
import {
  runLlmCall,
  llmCallConfigSchema,
  buildLlmCallConfig,
  presetParamsWithTemperature
} from './generationNodes'
import { extractTagAll } from './parseNodes'
import {
  chatTemplate,
  recentTranscript,
  renderTablesBlock,
  applyTableEdit,
  historyText,
  composedPromptDebug
} from './memoryCore'

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

export const memoryMaintainConfig = llmCallConfigSchema.extend({
  /** The scaffold/maintainer prompt (role-alternating). Routed to the Prompt editor (promptFields). */
  messages: z.array(memoryMessageSchema),
  /** Trailing floors of transcript to include (1..50). Default 6. */
  lastNFloors: z.number().int().min(1).max(50).optional(),
  /** Per-table row cap in the rendered block (keep the newest N). Unset → DEFAULT_MAX_ROWS (30, spec
   *  §1); an explicit 0 means uncapped. */
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

/** Per-table row cap applied when the config leaves `max_rows` unset (spec §1: "default 30"). An
 *  explicit `0` means uncapped. Kept as the ONE default so the node run + the panel preview agree. */
const DEFAULT_MAX_ROWS = 30

/** The fields of the config the prompt composition reads (a subset — the LLM knobs don't affect it). */
type ComposeConfig = Pick<
  z.infer<typeof memoryMaintainConfig>,
  'messages' | 'lastNFloors' | 'max_rows' | 'include_rules'
>

/**
 * Compose the fully-shaped maintainer prompt this node sends: render the tables block, splice the
 * recent transcript into the scaffold rows, substitute `{{tables}}`/`{{input}}` as DATA (after macros/
 * EJS), and provider-shape. Shared by the node's `run()` AND the panel preview IPC so the preview shows
 * EXACTLY what a run would send (no second compose path to drift). Exported for the preview handler +
 * tests.
 */
export const composeMaintainerMessages = (
  gen: GenContext,
  template: TableTemplate,
  cfg: ComposeConfig
): ChatMessage[] => {
  const { block: tablesBlock } = renderTablesBlock(gen, template, {
    maxRows: cfg.max_rows ?? DEFAULT_MAX_ROWS,
    includeRules: cfg.include_rules
  })
  const history = recentTranscript(gen, { lastNFloors: cfg.lastNFloors })
  const rows: ChatMessage[] = []
  for (const m of cfg.messages) {
    if (m.content.trim() === HISTORY_MARKER) {
      rows.push(...history)
      continue
    }
    // Interpolate the AUTHORED scaffold FIRST (macros/EJS), then substitute every model-derived slot —
    // {{tables}}/{{input}} and the inline {history} — as INERT DATA (split/join), so chat transcript /
    // table text can never pass through macro expansion or EJS eval. The composeRecallMessages /
    // composeNotesMaintainerMessages discipline.
    const interpolated = interpolate(m.content, {}, gen)
    const filled = interpolated
      .split('{{tables}}')
      .join(tablesBlock)
      .split('{{input}}')
      .join(tablesBlock)
      .split(HISTORY_MARKER)
      .join(historyText(history))
    rows.push({ role: m.role, content: filled })
  }
  return providerShape(gen.settings, rows)
}

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

    // Compose EXACTLY what the panel preview shows (composeMaintainerMessages is shared) — render the
    // tables block, splice {history}, substitute {{tables}}/{{input}} as DATA, provider-shape.
    const sendMessages = composeMaintainerMessages(gen, template, cfg)

    // Trace-only: the fully composed prompt (b1906ae debug channel) so "did the tables/history reach
    // the model" is inspectable in the Runs tab. Shared shape with agent.llm (composedPromptDebug).
    const promptDebug = composedPromptDebug(sendMessages)

    // Params + call config from the shared side-call builders (generationNodes) — stream defaults to
    // false (a maintenance reply is a side result, never the player-facing stream).
    const params = presetParamsWithTemperature(gen, cfg.temperature)
    const callCfg = buildLlmCallConfig(cfg)

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
