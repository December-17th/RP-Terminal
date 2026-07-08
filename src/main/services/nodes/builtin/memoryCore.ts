import { GenContext } from '../../generation/types'
import { ChatMessage } from '../../promptBuilder'
import { stripThinking } from '../../../parsers/contentParser'
import { getChatTableTemplateId } from '../../chatService'
import { getTableTemplateById } from '../../tableTemplateService'
import { applySqlBatch, TableSqlError } from '../../tableSql'
import { appendOps, tryBeginTableWrite, endTableWrite } from '../../tableOpsService'
import { advanceProgress } from '../../tableProgressService'
import { getAllFloors } from '../../floorService'
import { TableTemplate } from '../../../types/tableTemplate'
import { NodeRunFailure } from '../types'

/**
 * Shared SQL-table-memory internals (WP0 of the `memory.maintain` node plan) — the two pieces the
 * consolidated `memory.maintain` node shares with the fine-grained nodes, factored to ONE
 * implementation so the chains never drift:
 *   · `recentTranscript` — the last-N-floors transcript slice (`history.recent` wraps it).
 *   · `applyTableEdit`   — the LLM-emitted SQL-batch WRITE core (`table.apply` wraps it).
 * `chatTemplate` (resolve a chat's bound template, or null) moved here too since both nodes need it.
 * Behavior is byte-for-byte the pre-extraction code — the existing node characterization tests pin it.
 */

/** Resolve the table template a chat is bound to, or null when the chat has no table memory. */
export const chatTemplate = (gen: GenContext): TableTemplate | null => {
  const templateId = getChatTableTemplateId(gen.profileId, gen.chatId)
  return templateId ? getTableTemplateById(gen.profileId, templateId) : null
}

/**
 * The alternating transcript slice a memory agent reads: the last `lastNFloors` floors reduced to the
 * two things it cares about — the player action (`user`) and the AI reply (`assistant`, thinking
 * stripped). `include` narrows to one side; the default 'both' emits the player action THEN the reply
 * per floor (natural summarizer order). Blank sides are skipped. Pure over `gen.floors` (exported so
 * both `history.recent` and `memory.maintain` — and tests — share it).
 */
export const recentTranscript = (
  gen: GenContext,
  opts: { lastNFloors?: number; include?: 'both' | 'user' | 'assistant' } = {}
): ChatMessage[] => {
  const count = opts.lastNFloors ?? 6
  const include = opts.include ?? 'both'
  const selected = gen.floors.slice(-count)
  const messages: ChatMessage[] = []
  for (const f of selected) {
    if (include !== 'assistant') {
      const user = (f.user_message?.content ?? '').trim()
      if (user) messages.push({ role: 'user', content: user })
    }
    if (include !== 'user') {
      const assistant = stripThinking(f.response?.content ?? '').trim()
      if (assistant) messages.push({ role: 'assistant', content: assistant })
    }
  }
  return messages
}

/** What a successful table-edit apply reports (mirrors the applySqlBatch tally). */
export interface ApplyTableEditResult {
  applied: number
  changes: number
}

/**
 * Apply an LLM-emitted SQL batch to a chat's table sandbox — the WRITE core of `table.apply`, shared
 * with `memory.maintain`. Callers resolve `template` and enforce the no-template policy (a write with
 * no schema is a class-B error for `table.apply`, a silent no-op for `memory.maintain`), and MUST
 * pre-check for a blank batch (this assumes non-blank `sql`).
 *
 * Guards a per-chat write with `tryBeginTableWrite`/`endTableWrite`, runs `applySqlBatch`, appends the
 * EXACT executed statements to the just-persisted floor's op log (`floors.length - 1`, clamped), and —
 * when `advanceProgress` — advances the shared table-progress pointer to the current floor (re-read
 * from disk, the table.gate idiom) AFTER success only, so a failed batch leaves the backlog standing
 * for the next commit boundary to retry. `label` prefixes the thrown NodeRunFailure messages so each
 * caller's errors read naturally (defaults to `table.apply` — the pre-extraction wording).
 */
export const applyTableEdit = (
  gen: GenContext,
  template: TableTemplate,
  sql: string,
  opts: { maxChanges?: number; advanceProgress?: boolean; label?: string } = {}
): ApplyTableEditResult => {
  const label = opts.label ?? 'table.apply'
  if (!tryBeginTableWrite(gen.chatId)) {
    throw new NodeRunFailure('B', `${label}: a table write is already in flight for this chat`, 1, 'busy')
  }
  try {
    const result = applySqlBatch(gen.profileId, gen.chatId, template, sql, { maxChanges: opts.maxChanges })
    // Attribute ops to the just-persisted floor (this runs POST-response, so the reply floor is the
    // last one). Log EXACTLY the statements that ran (from the service), not a re-split, so replay
    // matches execution.
    if (result.statements.length) {
      const floor = Math.max(0, gen.floors.length - 1)
      appendOps(gen.profileId, gen.chatId, floor, result.statements)
    }
    // Advance the shared pointer ONLY after a successful batch (advance-after-success). currentFloor is
    // re-read FROM DISK here (the table.gate idiom), not from gen.floors.
    if (opts.advanceProgress === true) {
      const names = template.tables.map((t) => t.sqlName)
      const currentFloor = Math.max(0, getAllFloors(gen.profileId, gen.chatId).length - 1)
      advanceProgress(gen.profileId, gen.chatId, names, currentFloor)
    }
    return { applied: result.applied, changes: result.changes }
  } catch (error) {
    const msg = error instanceof TableSqlError ? error.message : String(error)
    throw new NodeRunFailure('B', `${label}: ${msg}`, 1, 'bad-sql')
  } finally {
    endTableWrite(gen.chatId)
  }
}
