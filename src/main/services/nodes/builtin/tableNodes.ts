import { z } from 'zod'
import { GenContext } from '../../generation/types'
import { getChatTableTemplateId } from '../../chatService'
import { getTableTemplateById } from '../../tableTemplateService'
import { applySqlBatch, TableSqlError } from '../../tableSql'
import { appendOps, tryBeginTableWrite, endTableWrite } from '../../tableOpsService'
import { readAllTables, TableRead } from '../../tableDbService'
import { synthesizeEntries } from '../../tableExportService'
import { matchAcross } from '../../lorebookService'
import { LorebookEntry } from '../../../types/character'
import { NodeImpl, NodeRunFailure } from '../types'

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
