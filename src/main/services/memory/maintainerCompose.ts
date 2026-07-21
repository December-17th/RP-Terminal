import { z } from 'zod'
import { GenContext } from '../generation/types'
import { ChatMessage } from '../promptBuilder'
import { TableTemplate } from '../../types/tableTemplate'
import { providerShape } from '../generation/providerShape'
import { interpolate } from '../promptInterpolate'
import { llmCallConfigSchema } from '../generation/llmCallConfig'
import { renderTablesBlock, recentTranscript, historyText } from './memoryCore'

/**
 * The SQL-table-memory maintainer-prompt composer + its config schema, relocated OUT of the
 * `memory.maintain` node file (`nodes/builtin/memoryNodes.ts`) into a stable service home
 * (execution-plan M5b) so the survivors that share it — the `memory-maintain-preview` IPC
 * (`tableMemoryIpc.ts`) and the converted Memory Maintenance Agent bridge
 * (`memoryMaintenanceAgentBridge.ts`) — keep working after M5c deletes the node wrappers. Moved
 * VERBATIM: the composed byte stream is pinned by the preview byte-parity tests and MUST NOT change.
 * `memoryNodes.ts` now re-imports both symbols from here so the node run and the preview/Agent share
 * ONE composer.
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

export type MemoryMaintainConfig = z.infer<typeof memoryMaintainConfig>

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
  cfg: ComposeConfig,
  opts: { scopeDirective?: string } = {}
): ChatMessage[] => {
  const { block: tablesBlock } = renderTablesBlock(gen, template, {
    maxRows: cfg.max_rows ?? DEFAULT_MAX_ROWS,
    includeRules: cfg.include_rules
  })
  const history = recentTranscript(gen, { lastNFloors: cfg.lastNFloors })
  const rows: ChatMessage[] = []
  // WS3: the auto pass prepends the shared write-scope directive so the model knows which tables it may
  // write this turn (the due set). Pre-`providerShape` so it participates in shaping like any system row;
  // absent (e.g. the preview IPC) → unchanged composition.
  if (opts.scopeDirective?.trim()) {
    rows.push({ role: 'system', content: opts.scopeDirective.trim() })
  }
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
