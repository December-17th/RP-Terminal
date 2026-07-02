import { z } from 'zod'
import { GenContext } from '../../generation/types'
import { getChatTableTemplateId } from '../../chatService'
import { getTableTemplateById } from '../../tableTemplateService'
import { applySqlBatch, executeReadQuery, TableSqlError } from '../../tableSql'
import { appendOps, tryBeginTableWrite, endTableWrite } from '../../tableOpsService'
import { readAllTables, TableRead } from '../../tableDbService'
import { synthesizeEntries, renderWholeTable } from '../../tableExportService'
import { matchAcross } from '../../lorebookService'
import { getAllFloors } from '../../floorService'
import { TableTemplate, TableDef } from '../../../types/tableTemplate'
import { LorebookEntry } from '../../../types/character'
import { NodeImpl, NodeRunFailure } from '../types'

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

/** Resolve the assigned template for a chat, or null (no table memory). */
const chatTemplate = (gen: GenContext): TableTemplate | null => {
  const templateId = getChatTableTemplateId(gen.profileId, gen.chatId)
  return templateId ? getTableTemplateById(gen.profileId, templateId) : null
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
  max_changes: z.number().int().min(1).max(5000).optional()
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

    const templateId = getChatTableTemplateId(gen.profileId, gen.chatId)
    const template = templateId ? getTableTemplateById(gen.profileId, templateId) : null
    if (!template) {
      throw new NodeRunFailure('B', 'table.apply: no table template assigned to this chat', 1, 'no-template')
    }

    if (!tryBeginTableWrite(gen.chatId)) {
      throw new NodeRunFailure('B', 'table.apply: a table write is already in flight for this chat', 1, 'busy')
    }
    try {
      const result = applySqlBatch(gen.profileId, gen.chatId, template, sql, {
        maxChanges: cfg.max_changes
      })
      // Attribute ops to the just-persisted floor. This node runs POST-response, so the reply floor
      // is already saved and is the LAST one: floors.length - 1, clamped to >= 0. Log EXACTLY the
      // statements that ran (from the service), not a re-split, so replay matches execution.
      if (result.statements.length) {
        const floor = Math.max(0, gen.floors.length - 1)
        appendOps(gen.profileId, gen.chatId, floor, result.statements)
      }
      return { outputs: { results: { applied: result.applied, changes: result.changes }, done: true } }
    } catch (error) {
      const msg = error instanceof TableSqlError ? error.message : String(error)
      throw new NodeRunFailure('B', `table.apply: ${msg}`, 1, 'bad-sql')
    } finally {
      endTableWrite(gen.chatId)
    }
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
 * AT-MOST-ONCE / FAIL-OPEN: durable node state is `{ last: Record<sqlName, number> }` — the floor
 * up to which each table was last maintained (missing = -1). A table is due when
 * `currentFloor - last[t] >= updateFrequency` (freq 1 = every turn). When the gate fires it ADVANCES
 * `last[dueTable] = currentFloor` IMMEDIATELY (atomically, before any downstream node runs). If the
 * downstream maintainer chain then fails, that span is simply skipped — worst case one missed
 * maintenance batch (fail-open by design, the same trade the old decomposed memory chain made, but
 * WITHOUT a claim/release lock since the advance is atomic here). No template / no due tables →
 * `{ outputs: {} }` (no signal), so a chat without table memory is a silent no-op.
 */
const gateConfig = z.object({
  /** Comma-separated sqlNames narrowing which tables the gate watches; unset = all template tables. */
  tables: z.string().optional()
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
  run: (ctx, inputs, node) => {
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

    const prev =
      (ctx.getNodeState(node.id) as { last?: Record<string, number>; at?: number } | undefined) ??
      {}
    const last = { ...(prev.last ?? {}) }

    // REWIND DETECTION: `at` records the floor at which this state was last written. node_state is
    // not floor-keyed, so after truncateFloors the pointers can point PAST the new floor count —
    // without a correction, `currentFloor - last` goes negative and maintenance stalls until the
    // chat re-grows past the old floor. `at > currentFloor` is unambiguous evidence of a rewind
    // (a same-floor re-run has at === currentFloor); on rewind, clamp every pointer to
    // currentFloor - 1 ("maintained through the previous floor") so cadences resume immediately.
    const rewound = prev.at != null && prev.at > currentFloor
    if (rewound) {
      for (const key of Object.keys(last)) last[key] = Math.min(last[key], currentFloor - 1)
    }

    const dueTables: string[] = []
    for (const t of tables) {
      const lastFloor = last[t.sqlName] ?? -1
      if (currentFloor - lastFloor >= t.updateFrequency) dueTables.push(t.sqlName)
    }
    if (!dueTables.length) return { outputs: {} } // nothing due this turn

    // span.from = the OLDEST last-maintained floor + 1 over the due tables (the first floor whose
    // content has not yet been folded into every due table); span.to = the current floor.
    const from = Math.min(...dueTables.map((t) => (last[t] ?? -1) + 1))

    // At-most-once: advance the pointer for every due table NOW, before anything downstream runs.
    for (const t of dueTables) last[t] = currentFloor
    ctx.setNodeState(node.id, { last, at: currentFloor })

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
 * Render one table's maintenance block: its header, definition + the applicable per-op rules, and
 * its current data. `init` rules are included ONLY when the table has 0 rows (the fresh-table case);
 * empty rule strings are omitted. `include_rules: false` renders just the header + data (the
 * definition + rules are all the "ingredients" the maintainer needs and are dropped together).
 *
 * ```
 * ## <displayName> (<sqlName>) — 每 N 轮维护
 * 【表定义】<note>              (with rules)
 * 【初始化规则】<initNode>       (with rules; only when the table has 0 rows)
 * 【插入规则】<insertNode>       (with rules)
 * 【更新规则】<updateNode>       (with rules)
 * 【删除规则】<deleteNode>       (with rules)
 * 【当前数据】
 * <renderWholeTable(headers, rows)>
 * ```
 */
const renderTableBlock = (table: TableDef, read: TableRead, includeRules: boolean): string => {
  const lines: string[] = [`## ${table.displayName} (${table.sqlName}) — 每 ${table.updateFrequency} 轮维护`]
  if (includeRules) {
    if (table.note.trim()) lines.push(`【表定义】${table.note}`)
    if (read.rows.length === 0 && table.initNode.trim()) lines.push(`【初始化规则】${table.initNode}`)
    if (table.insertNode.trim()) lines.push(`【插入规则】${table.insertNode}`)
    if (table.updateNode.trim()) lines.push(`【更新规则】${table.updateNode}`)
    if (table.deleteNode.trim()) lines.push(`【删除规则】${table.deleteNode}`)
  }
  lines.push('【当前数据】')
  lines.push(renderWholeTable(table.headers, read.rows))
  return lines.join('\n')
}

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
    const includeRules = cfg.include_rules !== false

    const template = chatTemplate(gen)
    if (!template) return { outputs: { block: '', tables: [] } } // read semantics — silent empty

    const only = parseSqlNameList(inputs.tables)
    const onlySet = only.length ? new Set(only) : null
    const tables = onlySet ? template.tables.filter((t) => onlySet.has(t.sqlName)) : template.tables
    if (!tables.length) return { outputs: { block: '', tables: [] } }

    const readsBySql = new Map(
      readAllTables(gen.profileId, gen.chatId, template).map((r) => [r.sqlName, r])
    )
    const blocks: string[] = []
    const rendered: string[] = []
    for (const table of tables) {
      let read = readsBySql.get(table.sqlName)
      if (!read) read = { sqlName: table.sqlName, displayName: table.displayName, columns: table.headers, rows: [] }
      // Row cap: keep the LAST N rows (newest-last) per table.
      if (cfg.max_rows != null && read.rows.length > cfg.max_rows) {
        read = { ...read, rows: read.rows.slice(-cfg.max_rows) }
      }
      blocks.push(renderTableBlock(table, read, includeRules))
      rendered.push(table.sqlName)
    }
    return { outputs: { block: blocks.join('\n\n'), tables: rendered } }
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
