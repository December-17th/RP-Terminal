import { BrowserWindow } from 'electron'

/**
 * Broadcast manual-backfill progress to open renderers (SQL-table-memory issue 07), following the
 * `chatEvents.ts` pattern: send to ALL windows, the renderer filters by `chatId`. Emitted after every
 * batch (and at start / on completion / cancellation / error) so the Tables view shows live progress
 * and refetches its tables + status.
 */

export type BackfillStatus =
  | 'running'
  | 'batch-ok'
  | 'batch-failed'
  | 'done'
  | 'cancelled'
  | 'error'

export interface BackfillProgress {
  chatId: string
  /** 0-based index of the batch just processed (or about to be); -1 before the first batch. */
  batchIndex: number
  /** Total number of batches in the run. */
  batchCount: number
  /** The floor span of the current/just-finished batch: `{ from, to }` (0-based). */
  span: { from: number; to: number } | null
  status: BackfillStatus
  /** Optional human-readable detail (a failure reason, or the run-level error). */
  message?: string
}

export const notifyBackfillProgress = (p: BackfillProgress): void => {
  for (const w of BrowserWindow.getAllWindows())
    w.webContents.send('table-backfill-progress', p)
}
