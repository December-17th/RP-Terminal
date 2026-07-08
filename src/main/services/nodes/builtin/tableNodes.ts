import { z } from 'zod'
import { GenContext } from '../../generation/types'
import { getChatTableTemplateId } from '../../chatService'
import { getTableTemplateById } from '../../tableTemplateService'
import { executeReadQuery, TableSqlError } from '../../tableSql'
import { readAllTables, TableRead } from '../../tableDbService'
import { synthesizeEntries, renderWholeTable } from '../../tableExportService'
import { getProgress, advanceProgress, resolveUpdateFrequency } from '../../tableProgressService'
import { getSettings } from '../../settingsService'
import { matchAcross } from '../../lorebookService'
import { getAllFloors } from '../../floorService'
import { TableDef } from '../../../types/tableTemplate'
import { LorebookEntry } from '../../../types/character'
import { NodeImpl, NodeRunFailure } from '../types'
import { chatTemplate, applyTableEdit, renderTablesBlock } from './memoryCore'

/** Parse a comma-separated sqlName list (trimmed, empties dropped). Accepts a string OR a string[]
 *  (the gate emits an array on its `tables` port; a config field is a comma string) — anything else
 *  → []. Shared by table.read (which accepts either shape on its `tables` input). */
const parseSqlNameList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean)
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * `table.apply` — the SQL-table-memory WRITE node (issue 03). Validates + executes an LLM-emitted
 * SQL batch against the chat's sandbox, appends the applied statements to the floor-keyed op log,
 * and reports per-statement counts. It is a POST-RESPONSE side branch and FAIL-OPEN for the turn:
 * every failure routes on the wireable `error` port (class-B) and NEVER aborts the graph. A blank/
 * whitespace `sql` is a silent no-op. `done` is emitted only on a completed apply (the vars.save
 * precedent), for ordering a downstream context refresh.
 */

const applyConfig = z.object({
  /** Per-batch row-change cap; a batch exceeding it rolls back entirely. Default 500. */
  max_changes: z.number().int().min(1).max(5000).optional(),
  /** Advance the chat-level table-progress pointer to the current floor AFTER a successful batch.
   *  Advance-AFTER-success semantics: a failed pass leaves the backlog standing and retries at the
   *  next commit boundary (one retry per boundary; the depth cap bounds the chain). This replaced
   *  `table.gate`'s advance-FIRST bookkeeping for the consolidated WP6.2 memory chains, which dropped
   *  the gate — without it the async trigger's `unprocessed` backlog never clears and
   *  `context.trimProcessed` is inert. Unset/false = no advance (compat: the pre-WP6.2b behavior). */
  advance_progress: z.boolean().optional()
})

type ApplyConfig = z.infer<typeof applyConfig>

export const tableApply: NodeImpl = {
  type: 'table.apply',
  title: 'Apply Table SQL',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'sql', type: 'Text' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'results', type: 'Any' },
    // Ordering-only, emitted ONLY on a completed apply (vars.save precedent) — wire into a
    // downstream context.refresh's `after` port to sequence the fresh read after the write lands.
    { name: 'done', type: 'Any' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: applyConfig,
  run: (_ctx, inputs, node) => {
    const sql = typeof inputs.sql === 'string' ? inputs.sql : ''
    if (!sql.trim()) return { outputs: {} } // silent no-op — nothing to apply

    const gen = inputs.gen as GenContext
    const cfg = node.config as ApplyConfig

    // A write with no schema is a real error (contrast table.export's silent read) — kept here so the
    // blank-sql short-circuit above still wins over the no-template check.
    const template = chatTemplate(gen)
    if (!template) {
      throw new NodeRunFailure('B', 'table.apply: no table template assigned to this chat', 1, 'no-template')
    }

    // The write core (busy-guard + applySqlBatch + op-log + advance-after-success) is shared with
    // memory.maintain (memoryCore.applyTableEdit) — throws class-B on busy/bad-sql, same as before.
    const r = applyTableEdit(gen, template, sql, {
      maxChanges: cfg.max_changes,
      advanceProgress: cfg.advance_progress
    })
    return { outputs: { results: { applied: r.applied, changes: r.changes }, done: true } }
  }
}

/**
 * `table.export` — the SQL-table-memory READ-INTO-THE-PROMPT node (issue 04). Projects the chat's
 * tables into REAL lorebook-style entries per each table's `exportConfig`, then QUALIFIES them through
 * the real world-info matcher against `gen.scanText`: constant entries always survive, keyword entries
 * only on a scan hit. The qualified entries feed `prompt.assemble` / `prompt.preset`'s new `entries`
 * port; the node does NOT auto-inject anywhere — projection reaches the prompt ONLY through wiring.
 *
 * No template assigned → SILENT empty output (`{ entries: [], block: '' }`), NOT an error: export is a
 * READ, and a chat without table memory simply projects nothing (contrast table.apply's no-template
 * class-B failure — a write with no schema is a real error).
 */
const exportConfig = z.object({
  /** Comma-separated sqlNames narrowing WHICH tables project; unset/empty = all. */
  tables: z.string().optional(),
  /** Per-table cap on projected DATA rows (int 1..500); keeps the NEWEST-last rows. Unset = all rows. */
  max_rows: z.number().int().min(1).max(500).optional()
})

type ExportConfig = z.infer<typeof exportConfig>

/** The top World Info block text of the qualified entries: null-depth entries' content, joined like
 *  promptBuilder's top block (blank content dropped, '\n\n'-separated). For composed prompts that want
 *  a plain text rendering rather than the entry objects. */
const exportBlock = (entries: LorebookEntry[]): string =>
  entries
    .filter((e) => e.insertion_depth == null)
    .map((e) => e.content)
    .filter(Boolean)
    .join('\n\n')

export const tableExport: NodeImpl = {
  type: 'table.export',
  title: 'Export Table',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'entries', type: 'Any' },
    { name: 'block', type: 'Text' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: exportConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const cfg = node.config as ExportConfig

    const templateId = getChatTableTemplateId(gen.profileId, gen.chatId)
    const template = templateId ? getTableTemplateById(gen.profileId, templateId) : null
    // No table memory on this chat → project nothing (silent; export is a read).
    if (!template) return { outputs: { entries: [], block: '' } }

    // Optional narrowing to a subset of tables (by sqlName). Empty filter = all tables.
    const only = (cfg.tables ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    let reads: TableRead[] = readAllTables(gen.profileId, gen.chatId, template)
    if (only.length) {
      const set = new Set(only)
      reads = reads.filter((r) => set.has(r.sqlName))
    }
    // Row cap: keep the LAST N rows (newest-last) per table so long tables don't blow the prompt.
    if (cfg.max_rows != null) {
      const cap = cfg.max_rows
      reads = reads.map((r) => (r.rows.length > cap ? { ...r, rows: r.rows.slice(-cap) } : r))
    }

    const synthesized = synthesizeEntries(template, reads)
    // QUALIFY through the REAL matcher — constants survive, keyword entries fire only on a scan hit.
    const qualified = matchAcross(
      [{ name: 'table-export', entries: synthesized }],
      gen.scanText,
      Math.random,
      gen.maxRecursion
    )
    return { outputs: { entries: qualified, block: exportBlock(qualified) } }
  }
}

// ---- Maintenance pipeline (issue 05) ---------------------------------------------------------

/**
 * `table.gate` — the per-table update-frequency CADENCE gate for post-response table maintenance.
 * It fires `due` once any watched table's `updateFrequency` window has elapsed, emitting the due
 * table ids (`tables`) and the aged floor span (`span`) so the downstream maintainer chain knows
 * WHAT to update and OVER WHICH floors.
 *
 * FLOOR SOURCE — the gate re-reads the floor count FROM DISK via `getAllFloors(...).length - 1`,
 * NOT `gen.floors`: `gen.floors` is the PRE-turn snapshot `input.context` took at the top of the
 * graph, so the just-persisted reply floor is missing from it. The `floor` input is ORDERING-ONLY
 * (wire it from `output.writeFloor.floor`) — its VALUE is ignored; it exists to sequence the gate
 * AFTER the turn is persisted so the disk read sees the new floor (the same contract the removed
 * `memory.gate` carried).
 *
 * AT-MOST-ONCE / FAIL-OPEN: the last-processed pointer now lives in the CHAT-LEVEL progress store
 * (`tableProgressService`), shared with the manual backfill and the Tables view — NOT per-workflow
 * node state (issue 07 retired that, including its `at` rewind discriminator; the store is clamped
 * explicitly on truncation). A table is due when `currentFloor - (progress[t] ?? -1) >= updateFrequency`
 * (freq 1 = every turn). When the gate fires it ADVANCES the store for every due table to
 * `currentFloor` IMMEDIATELY (max-semantics upsert, before any downstream node runs). If the
 * downstream maintainer chain then fails, that span is simply skipped — worst case one missed
 * maintenance batch (fail-open by design). No template / no due tables → `{ outputs: {} }` (no
 * signal), so a chat without table memory is a silent no-op.
 */
const gateConfig = z.object({
  /** Comma-separated sqlNames narrowing which tables the gate watches; unset = all template tables. */
  tables: z.string().optional(),
  /** Run the maintenance only every N floors: OVERRIDES every watched table's own updateFrequency,
   *  INCLUDING a table authored OFF (updateFrequency 0) — `every` is the workflow author's explicit
   *  cadence override, so it re-includes an off table (imported chatSheets templates often carry `-1`
   *  = use-global, which the resolver expands; this is the player's global cadence knob). Unset =
   *  per-table resolved frequencies (0 = off → the table is never due). */
  every: z.number().int().min(1).max(500).optional()
})

type GateConfig = z.infer<typeof gateConfig>

export const tableGate: NodeImpl = {
  type: 'table.gate',
  title: 'Table Gate',
  inputs: [
    { name: 'gen', type: 'Context' },
    // ORDERING-ONLY (value ignored): wire from output.writeFloor.floor so the gate re-reads the
    // floor count AFTER the reply floor is persisted.
    { name: 'floor', type: 'Any' }
  ],
  outputs: [
    { name: 'due', type: 'Signal' },
    { name: 'tables', type: 'Any' }, // due sqlNames[]
    { name: 'span', type: 'Any' } // { from, to } floor range aged in since last maintenance
  ],
  configSchema: gateConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const cfg = node.config as GateConfig

    const template = chatTemplate(gen)
    if (!template) return { outputs: {} } // no table memory → silent no-op

    // Narrow to the configured subset (by sqlName); empty filter = every template table.
    const watch = parseSqlNameList(cfg.tables)
    const watchSet = watch.length ? new Set(watch) : null
    const tables: TableDef[] = watchSet
      ? template.tables.filter((t) => watchSet.has(t.sqlName))
      : template.tables
    if (!tables.length) return { outputs: {} }

    // Re-read the floor count FROM DISK (gen.floors is the pre-turn snapshot); currentFloor is the
    // 0-based index of the last persisted floor (clamped ≥0 for an empty chat).
    const currentFloor = Math.max(0, getAllFloors(gen.profileId, gen.chatId).length - 1)

    // Last-processed pointers from the chat-level store (shared with backfill + the display). A
    // missing table is -1; the store is clamped explicitly on truncation, so no rewind inference here.
    const progress = getProgress(gen.profileId, gen.chatId)
    const globalDefault = getSettings(gen.profileId).tables?.default_update_frequency ?? 3

    const dueTables: string[] = []
    for (const t of tables) {
      const lastFloor = progress[t.sqlName] ?? -1
      // `every` (when set) is the global cadence override — it OVERRIDES everything, including an
      // off table (updateFrequency 0), so the whole pass runs at most every N floors. Unset → the
      // per-table frequency RESOLVED against the app global default (-1 → global, 0 → null = never
      // due / skipped, N → N).
      const frequency = cfg.every ?? resolveUpdateFrequency(t.updateFrequency, globalDefault)
      if (frequency == null) continue // off table, no `every` override → never due
      if (currentFloor - lastFloor >= frequency) dueTables.push(t.sqlName)
    }
    if (!dueTables.length) return { outputs: {} } // nothing due this turn

    // span.from = the OLDEST last-processed floor + 1 over the due tables (the first floor whose
    // content has not yet been folded into every due table); span.to = the current floor.
    const from = Math.min(...dueTables.map((t) => (progress[t] ?? -1) + 1))

    // At-most-once: advance the pointer for every due table NOW, before anything downstream runs.
    advanceProgress(gen.profileId, gen.chatId, dueTables, currentFloor)

    return { outputs: { tables: dueTables, span: { from, to: currentFloor } }, signals: ['due'] }
  }
}

const readConfig = z.object({
  /** Include each table's per-op rules (init/insert/update/delete). Default true. */
  include_rules: z.boolean().optional(),
  /** Per-table cap on rendered DATA rows (int 1..500); keeps the NEWEST-last rows. Unset = all rows. */
  max_rows: z.number().int().min(1).max(500).optional()
})

type ReadConfig = z.infer<typeof readConfig>

/**
 * `table.read` — renders the "here are the tables, here is what you may do" block the maintainer
 * prompt needs: for the selected (or due) tables, each one's definition + per-op rules + current
 * data. This is a READ: no template / no selected tables → SILENT empty outputs (the table.export
 * precedent), NEVER an error.
 *
 * SCOPE: the `tables` input takes the gate's due sqlNames[] (or a comma-separated string); when it
 * is unwired/empty, ALL template tables are rendered. The rendered scope is passed through on the
 * `tables` output so the apply stage knows what was in scope.
 */
export const tableRead: NodeImpl = {
  type: 'table.read',
  title: 'Read Tables',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'tables', type: 'Any' }, // sqlNames[] (or comma string); unwired = all
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'block', type: 'Text' },
    { name: 'tables', type: 'Any' } // passthrough of the rendered scope
  ],
  configSchema: readConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const cfg = node.config as ReadConfig

    const template = chatTemplate(gen)
    if (!template) return { outputs: { block: '', tables: [] } } // read semantics — silent empty

    // The block render is shared with memory.maintain (memoryCore.renderTablesBlock) — an empty scope
    // (no matching tables) still yields the silent-empty output.
    const { block, tables } = renderTablesBlock(gen, template, {
      maxRows: cfg.max_rows,
      includeRules: cfg.include_rules,
      only: parseSqlNameList(inputs.tables)
    })
    return { outputs: { block, tables } }
  }
}

/**
 * `table.query` — a VALIDATED read-only query for planner / 剧情推进 branches: a bare registered
 * table name or a single SELECT statement (validated read-only against the template's registry via
 * `validateReadQuery`, executed against the sandbox opened `{ readonly: true }`). Returns the result
 * rows (positional arrays) + a rendered text block.
 *
 * A READ: a blank query, or no assigned template, → SILENT empty (`{ rows: [], block: '' }`), never
 * an error (the table.export precedent). Only a genuinely bad query (a write head, WITH, a multi-
 * statement text, an unknown bare name, or a SQLite runtime failure) is a class-B `bad-query` routed
 * on the `error` port. Missing sandbox (template assigned but never instantiated) → silent empty.
 */
export const tableQuery: NodeImpl = {
  type: 'table.query',
  title: 'Query Tables',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'query', type: 'Text' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'rows', type: 'Any' }, // array of positional row arrays (better-sqlite3 .raw().all())
    { name: 'block', type: 'Text' }, // rendered result (renderWholeTable)
    { name: 'error', type: 'Error' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const query = typeof inputs.query === 'string' ? inputs.query : ''
    if (!query.trim()) return { outputs: { rows: [], block: '' } } // blank → silent empty

    const template = chatTemplate(gen)
    if (!template) return { outputs: { rows: [], block: '' } } // no table memory → silent empty

    try {
      const { columns, rows } = executeReadQuery(gen.profileId, gen.chatId, template, query)
      return { outputs: { rows, block: renderWholeTable(columns, rows) } }
    } catch (error) {
      const msg = error instanceof TableSqlError ? error.message : String(error)
      throw new NodeRunFailure('B', `table.query: ${msg}`, 1, 'bad-query')
    }
  }
}
