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
  dueTables,
  historyText,
  composedPromptDebug
} from './memoryCore'
import { getProgress, advanceProgress } from '../../tableProgressService'
import { getAllFloors, transcriptEpoch } from '../../floorService'
import { getSettings } from '../../settingsService'
import { writeScopeDirective } from '../../tableMaintenance'

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

export const memoryMaintain: NodeImpl = {
  type: 'memory.maintain',
  title: 'Memory',
  // The scaffold prompt is routed to the dedicated Prompt editor + drives the on-card excerpt.
  promptFields: ['messages'],
  inputs: [
    // Optional Context (mirrors memory.recall's `gen` port). When wired, the upstream bundle is reused;
    // when unwired it self-seeds — byte-identical to the pre-A6 behaviour.
    { name: 'gen', type: 'Context' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'report', type: 'Text' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: memoryMaintainConfig,
  run: async (ctx, inputs, node) => {
    const cfg = node.config as MemoryMaintainConfig
    // Prefer the upstream input.context bundle; self-seed only when run headless/without it.
    const gen: GenContext =
      (inputs.gen as GenContext | undefined) ?? buildGenContext(ctx.profileId!, ctx.chatId!, '')

    // No table memory bound → silent no-op (table.read/table.export read-semantics; do NOT burn a
    // model call when there is nothing to maintain).
    const template = chatTemplate(gen)
    if (!template) return { outputs: {} }

    // WS3 — auto due-set gating (D9): compute the DUE tables BEFORE the model call. The node runs every
    // turn (the cadence gate) but only pays for a model call when at least one table is due; an empty due
    // set SKIPS the LLM entirely. currentFloor is re-read from disk to match the pointer semantics.
    const currentFloor = Math.max(0, getAllFloors(gen.profileId, gen.chatId).length - 1)
    const globalDefault = getSettings(gen.profileId).tables?.default_update_frequency ?? 3
    const due = dueTables(template, getProgress(gen.profileId, gen.chatId), currentFloor, globalDefault)
    if (!due.length) return { outputs: { report: 'no tables due' } }

    // Staleness fence (owner pass 2026-07-14): capture the transcript epoch in the SAME sync block
    // that composes from the floors. If a regenerate/edit/swipe lands while the model call below is
    // in flight, the epoch moves and applyTableEdit drops the batch — otherwise the discarded reply's
    // facts would fill the tables AND re-advance the pointers truncateFloors just clamped.
    const composedEpoch = transcriptEpoch(gen.chatId)

    // The due tables' display names drive the shared write-scope directive (WS2/WS3 parity). All tables
    // still RENDER in the block (full context, D5); only the due ones may be written this turn.
    const dueSet = new Set(due)
    const dueDisplay = template.tables.filter((t) => dueSet.has(t.sqlName)).map((t) => t.displayName)

    // Compose EXACTLY what the panel preview shows (composeMaintainerMessages is shared) — render the
    // tables block, splice {history}, substitute {{tables}}/{{input}} as DATA, provider-shape — plus the
    // due-set write-scope directive prepended.
    const sendMessages = composeMaintainerMessages(gen, template, cfg, {
      scopeDirective: writeScopeDirective(dueDisplay)
    })

    // Trace-only: the fully composed prompt (b1906ae debug channel) so "did the tables/history reach
    // the model" is inspectable in the Runs tab. Shared shape with agent.llm (composedPromptDebug).
    const promptDebug = composedPromptDebug(sendMessages)

    // Params + call config from the shared side-call builders (generationNodes) — stream defaults to
    // false (a maintenance reply is a side result, never the player-facing stream).
    const params = presetParamsWithTemperature(gen, cfg.temperature)
    // Node-level retry default (owner directive 2026-07-14): a maintain pass whose config doesn't pin
    // `retries` gets the FULL budget (5) — memory fills are side calls prone to transient empty
    // streams, and a dropped pass silently loses whole cadence cycles. An authored value still wins.
    const callCfg = buildLlmCallConfig({ ...cfg, retries: cfg.retries ?? 5 })

    const r = await runLlmCall(ctx, gen, sendMessages, params, callCfg)
    // Abort-with-empty: no reply to parse; the prompt is still traced so the empty result is diagnosable.
    if (r === null) return { outputs: {}, debug: promptDebug }

    // Pull the SQL batch out of the <TableEdit> tag. extractTagAll returns [] when NO tag is present
    // and [''] for an explicit empty `<TableEdit></TableEdit>` — a distinction that matters here:
    //  - NO tag → malformed reply. Do NOT advance the due pointers (advancing would silently skip this
    //    turn's content forever); report and no-op so the next commit boundary retries the same floors.
    //  - EMPTY tag → a COMPLIANT "no changes" reply (maintainer rule 4). It MUST advance the due pointers
    //    or the due tables stay due and burn a model call EVERY turn until the model happens to write.
    const tags = extractTagAll(r.raw, 'TableEdit')
    if (!tags.length) {
      return { outputs: { report: 'no TableEdit tag in reply' }, debug: promptDebug }
    }
    const sql = tags[0] ?? ''
    if (!sql.trim()) {
      // Advance-on-empty bypasses applyTableEdit, so it must re-run the staleness fence itself: if a
      // regenerate/edit/swipe landed mid-call the epoch moved, and advancing here would re-advance the
      // pointers truncateFloors just clamped. Only advance when the transcript is still the one read.
      if (cfg.advance_progress !== false) {
        if (transcriptEpoch(gen.chatId) !== composedEpoch) {
          return { outputs: { report: 'stale transcript, skipped' }, debug: promptDebug }
        }
        advanceProgress(gen.profileId, gen.chatId, due, currentFloor)
      }
      return { outputs: { report: 'no changes' }, debug: promptDebug }
    }

    // Apply via the shared write-core (busy-guard + applySqlBatch + op-log + advance-after-success);
    // a bad batch throws class-B and routes on the `error` port. WS3: the write scope + advance set are
    // the DUE tables — out-of-scope statements the model emitted anyway are dropped, and only the due
    // pointers advance (the non-due tables' backlog stands for their own cadence turn).
    const applied = applyTableEdit(gen, template, sql, {
      advanceProgress: cfg.advance_progress !== false,
      writeScope: due,
      advanceTables: due,
      label: 'memory.maintain',
      expectTranscriptEpoch: composedEpoch,
      // Advance to the floor the model actually READ, not a disk re-read — a floor appended while
      // the call was in flight must stay in the backlog for its own maintenance pass.
      advanceTo: currentFloor
    })
    if (applied.stale) {
      // Regenerate/edit/swipe landed mid-call: the batch was composed from floors that no longer
      // exist as read. Dropped without applying or advancing — the next commit boundary re-runs
      // against the NEW content (truncateFloors already clamped the pointers).
      return { outputs: { report: 'stale transcript, skipped' }, debug: promptDebug }
    }
    const dropped = applied.dropped ? `, dropped ${applied.dropped} out-of-scope` : ''
    return {
      outputs: {
        report: `applied ${applied.applied} statement(s), ${applied.changes} change(s)${dropped}`
      },
      debug: promptDebug
    }
  }
}
