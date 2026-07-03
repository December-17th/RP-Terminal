import { TableDef } from '../types/tableTemplate'
import { TableRead } from './tableDbService'
import { renderWholeTable } from './tableExportService'

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
export const renderTableBlock = (table: TableDef, read: TableRead, includeRules: boolean): string => {
  const lines: string[] = [
    `## ${table.displayName} (${table.sqlName}) — 每 ${table.updateFrequency} 轮维护`
  ]
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
 * The shared maintainer rules (zh). This is the SAME contract the example workflow's `frame` node
 * carries (`docs/workflows/table-memory-default.rptflow`) — factored here so the per-turn chain and
 * the backfill stay in lockstep. Keep the two consistent: a change here that alters the contract
 * should be mirrored in the .rptflow's system prompt.
 */
export const MAINTAINER_RULES = `规则：
1. 只输出 SQL 语句，全部包裹在一个 <TableEdit>…</TableEdit> 标签内。标签内不要写任何解释或注释。
2. 仅允许对上面列出的表执行 INSERT / UPDATE / DELETE，禁止其它操作。
3. 严格遵循每个表的【插入规则】【更新规则】【删除规则】（表为空时遵循【初始化规则】）。
4. 只在确有变化时更新；若本批没有任何需要写入的变化，输出一个空的 <TableEdit></TableEdit>。`

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
