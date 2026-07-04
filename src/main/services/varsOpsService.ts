import { getDb } from './db'
import { log } from './logService'

/**
 * Floor-keyed op log for CARD/PANEL variable writes (manual-pass issue 02).
 *
 * `stat_data` is rebuilt from the model's `<UpdateVariable>` blocks on `reevaluateVariables`, but
 * card writes (JSON-Patch via `applyVariableOps`, whole-replace via `wcv-host-set-vars`) are NOT
 * re-derivable from response text. Each such write is appended to `vars_ops (chat_id, floor, seq,
 * kind, payload)` in the APP DB and REPLAYED after the model fold of its floor during
 * re-evaluation, so a chat mutation that triggers the re-fold no longer silently wipes them. This
 * mirrors the SQL-table-memory `table_ops` journal + replay pattern (tableOpsService.ts).
 *
 * Kind 'patch' carries the applied JsonPatchOp[]; 'replace' carries a whole stat_data object.
 * Reads are FAIL-OPEN: a row whose payload no longer parses is logged and skipped, never bricking
 * the chat (the rebuildSandbox precedent). Truncation drops ops at/after the cut
 * (`deleteVarsOpsFrom`, hooked in chatService.truncateFloors); chat deletion goes via FK cascade.
 */

export type VarsOpKind = 'patch' | 'replace'

export interface VarsOpRow {
  floor: number
  seq: number
  kind: VarsOpKind
  payload: unknown
}

/** Append a card write op at `floor`, continuing the per-(chat,floor) `seq` counter. */
export const appendVarsOp = (
  chatId: string,
  floor: number,
  kind: VarsOpKind,
  payload: unknown
): void => {
  const db = getDb()
  const row = db
    .prepare('SELECT MAX(seq) AS maxSeq FROM vars_ops WHERE chat_id = ? AND floor = ?')
    .get(chatId, floor) as { maxSeq: number | null } | undefined
  const seq = (row?.maxSeq ?? -1) + 1
  db.prepare(
    'INSERT INTO vars_ops (chat_id, floor, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(chatId, floor, seq, kind, JSON.stringify(payload), new Date().toISOString())
}

/** All card write ops for a chat, ordered by (floor, seq) — the replay order. Fail-open on parse. */
export const listVarsOps = (chatId: string): VarsOpRow[] => {
  const rows = getDb()
    .prepare('SELECT floor, seq, kind, payload FROM vars_ops WHERE chat_id = ? ORDER BY floor, seq')
    .all(chatId) as Array<{ floor: number; seq: number; kind: VarsOpKind; payload: string }>
  const out: VarsOpRow[] = []
  for (const r of rows) {
    try {
      out.push({ floor: r.floor, seq: r.seq, kind: r.kind, payload: JSON.parse(r.payload) })
    } catch (error) {
      log(
        'info',
        `Skipped unparseable vars_op (chat ${chatId}, floor ${r.floor}, seq ${r.seq}): ${String(error)}`
      )
    }
  }
  return out
}

/** Drop every card write op at/after `fromFloor` (truncation cut). Returns the rows deleted. */
export const deleteVarsOpsFrom = (chatId: string, fromFloor: number): number =>
  getDb()
    .prepare('DELETE FROM vars_ops WHERE chat_id = ? AND floor >= ?')
    .run(chatId, fromFloor).changes
