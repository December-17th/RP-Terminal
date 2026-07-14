import { TableDef, TableTemplate } from '../types/tableTemplate'
import { TableRead } from './tableDbService'
import { renderWholeTable } from './tableExportService'
import { parseDdlColumnNames } from '../parsers/chatSheetsParser'
import { resolveUpdateFrequency } from './tableProgressService'

/**
 * Shared maintainer building blocks for SQL-table memory (issue 07). Both the per-turn maintenance
 * chain (`nodes/builtin/tableNodes.ts` `table.read`) and the manual backfill (`tableBackfillService`)
 * render the "here are the tables, here is what you may do" block through the SAME `renderTableBlock`
 * — no copy. The backfill prompt reuses the example workflow's maintainer contract (kept consistent —
 * `docs/workflows/table-memory-default.rptflow`'s `frame` system prompt) plus a per-batch rule.
 */

/**
 * Render one table's maintenance block: its header, definition + the applicable per-op rules, and its
 * current data. `init` rules are included ONLY when the table has 0 rows (the fresh-table case); empty
 * rule strings are omitted. `include_rules: false` renders just the header + data.
 *
 * `resolvedFrequency` is the table's cadence AFTER resolving `updateFrequency` against the app global
 * default (`resolveUpdateFrequency`): a positive N renders `每 N 轮维护`; `null` (an off table, authored
 * `0`, nonetheless explicitly rendered) renders `— 手动维护`.
 *
 * ```
 * ## <displayName> (<sqlName>) — 每 N 轮维护        (or "— 手动维护" when off)
 * 【建表语句】<ddl>             (with rules; the CREATE TABLE — real SQL column names + zh mapping)
 * 【表定义】<note>              (with rules)
 * 【初始化规则】<initNode>       (with rules; only when the table has 0 rows)
 * 【插入规则】<insertNode>       (with rules)
 * 【更新规则】<updateNode>       (with rules)
 * 【删除规则】<deleteNode>       (with rules)
 * 【当前数据】
 * <renderWholeTable(sqlColumns, rows)>
 * ```
 *
 * The 【当前数据】 header line and 【建表语句】 use the DDL's REAL column names (`parseDdlColumnNames`),
 * NOT `table.headers` (which are the zh DISPLAY labels, e.g. 人物名称) — so the model writes SQL
 * against the actual columns (e.g. `name`) instead of the display labels, which SQLite rejects. Rows
 * are positional in DDL order (== the sandbox `SELECT *` order), so the real-name header aligns 1:1.
 * Falls back to `table.headers` only when the DDL yields no parsable columns.
 */
export const renderTableBlock = (
  table: TableDef,
  read: TableRead,
  includeRules: boolean,
  resolvedFrequency: number | null
): string => {
  const cadence = resolvedFrequency == null ? '手动维护' : `每 ${resolvedFrequency} 轮维护`
  const lines: string[] = [`## ${table.displayName} (${table.sqlName}) — ${cadence}`]
  if (includeRules) {
    if (table.ddl.trim()) lines.push(`【建表语句】\n${table.ddl.trim()}`)
    if (table.note.trim()) lines.push(`【表定义】${table.note}`)
    if (read.rows.length === 0 && table.initNode.trim()) lines.push(`【初始化规则】${table.initNode}`)
    if (table.insertNode.trim()) lines.push(`【插入规则】${table.insertNode}`)
    if (table.updateNode.trim()) lines.push(`【更新规则】${table.updateNode}`)
    if (table.deleteNode.trim()) lines.push(`【删除规则】${table.deleteNode}`)
  }
  lines.push('【当前数据】')
  const sqlCols = parseDdlColumnNames(table.ddl)
  lines.push(renderWholeTable(sqlCols.length ? sqlCols : table.headers, read.rows))
  return lines.join('\n')
}

/**
 * Compose the whole "here are the tables + rules + current data" block for a maintainer pass: every
 * template table rendered via `renderTableBlock` (with rules, cadence header) over its `TableRead`,
 * joined by blank lines. Factored so the manual BACKFILL (reads the live sandbox) and the REFILL engine
 * (reads its temp shadow sandbox) build a byte-identical block from whatever reads they pass — no
 * copy-paste of the compose loop. A table with no matching read renders as empty (headers, no rows).
 */
export const composeTablesBlock = (
  template: TableTemplate,
  reads: TableRead[],
  globalDefault: number
): string => {
  const readBySql = new Map(reads.map((r) => [r.sqlName, r]))
  return template.tables
    .map((t) => {
      const read =
        readBySql.get(t.sqlName) ??
        ({ sqlName: t.sqlName, displayName: t.displayName, columns: t.headers, rows: [], rowids: [] } as TableRead)
      return renderTableBlock(t, read, true, resolveUpdateFrequency(t.updateFrequency, globalDefault))
    })
    .join('\n\n')
}

/**
 * The write-scope directive: "only the listed tables may be written this run; the rest are shown for
 * context only." Shared by the REFILL maintainer prompt (WS2) and the AUTOMATIC due-set maintainer pass
 * (WS3, `memory.maintain`), so the two callers never drift. `scopeDisplay` is the SELECTED/DUE tables'
 * display names; an empty list renders `（无）`. Out-of-scope statements the model emits anyway are
 * dropped by the shared write-scope filter (`partitionBySelected`), but the directive keeps it on task.
 */
export const writeScopeDirective = (scopeDisplay: string[]): string => {
  const scope = scopeDisplay.length ? scopeDisplay.join('、') : '（无）'
  return `【本次只更新以下表】${scope}
其它表格仅供参考，禁止对其执行任何 INSERT / UPDATE / DELETE。`
}

/**
 * The REFILL maintainer system prompt for one batch (table-refill WS2 / plan D8): reuses the backfill
 * framing (tables block + a `{from}..{to}` batch treated as one 交互) and ADDS the shared write-scope
 * directive (`writeScopeDirective`) — only the SELECTED tables (`selectedDisplay`) may be written this
 * run. An optional `extraHint` is folded in as a trailing instruction. `from`/`to` are 0-based floor
 * indices.
 */
export const refillMaintainerPrompt = (
  tablesBlock: string,
  transcript: string,
  from: number,
  to: number,
  selectedDisplay: string[],
  extraHint?: string
): string => {
  const hint = extraHint?.trim() ? `\n\n【额外要求】${extraHint.trim()}` : ''
  return `你是数据库表格维护AI（database-table maintenance AI）。下面是记忆表格，每个表附带其定义与可执行的操作，随后是这一批的剧情。请根据本批剧情重新填写表格。

以下【本批剧情】包含第 ${from}–${to} 层的多轮对话；将其视为一次交互进行维护：纪要表只允许新增恰好一行（概括整批），其余表按各自规则维护。

${writeScopeDirective(selectedDisplay)}${hint}

【表格与规则】
${tablesBlock}

【本批剧情】
${transcript}

${MAINTAINER_RULES}`
}

/**
 * The shared maintainer rules (zh). This is the SAME contract the example workflow's `frame` node
 * carries (`docs/workflows/table-memory-default.rptflow`) — factored here so the per-turn chain and
 * the backfill stay in lockstep. Keep the two consistent: a change here that alters the contract
 * should be mirrored in the .rptflow's system prompt.
 */
export const MAINTAINER_RULES = `规则：
1. 只输出 SQL 语句，全部包裹在一个 <TableEdit>…</TableEdit> 标签内。标签内不要写任何解释或注释。
2. 仅允许对上面列出的表执行 INSERT / UPDATE / DELETE，禁止其它操作。
3. 严格遵循每个表的【插入规则】【更新规则】【删除规则】（表为空时遵循【初始化规则】）。
4. 只在确有变化时更新；若本批没有任何需要写入的变化，输出一个空的 <TableEdit></TableEdit>。
5. 表格是历史档案，不是创作工具：只记录剧情中已经明确发生的事实。禁止编造、推测、预告或推进任何新剧情、新事件、新对话；禁止把"计划""预测""可能发生的事"写入任何表；没有把握的内容一律不写。
6. SQL 只能使用每个表【建表语句】中的真实英文列名（如 name），绝不要使用中文显示表头（如 人物名称）。INSERT 时 row_id 取该表当前最大 row_id + 1；UPDATE / DELETE 必须带 WHERE 条件。`

/**
 * Build the backfill maintainer system prompt for ONE batch (issue 07 §3). Reuses the maintainer
 * rules above, frames the tables block + the batch transcript, and adds the batch rule: the whole
 * `{from}..{to}` floor span is treated as ONE 交互 — 纪要表 gains exactly one new row, all other
 * tables are maintained normally. `from`/`to` are 0-based floor indices.
 */
export const backfillMaintainerPrompt = (
  tablesBlock: string,
  transcript: string,
  from: number,
  to: number
): string =>
  `你是数据库表格维护AI（database-table maintenance AI）。下面是记忆表格，每个表附带其定义与可执行的操作，随后是这一批的剧情。请根据本批剧情更新表格。

以下【本批剧情】包含第 ${from}–${to} 层的多轮对话；将其视为一次交互进行维护：纪要表只允许新增恰好一行（概括整批），其余表按各自规则维护。

【表格与规则】
${tablesBlock}

【本批剧情】
${transcript}

${MAINTAINER_RULES}`
