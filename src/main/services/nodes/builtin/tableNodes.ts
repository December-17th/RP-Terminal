import { z } from 'zod'
import { GenContext } from '../../generation/types'
import { getChatTableTemplateId } from '../../chatService'
import { getTableTemplateById } from '../../tableTemplateService'
import { applySqlBatch, TableSqlError } from '../../tableSql'
import { appendOps, tryBeginTableWrite, endTableWrite } from '../../tableOpsService'
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
