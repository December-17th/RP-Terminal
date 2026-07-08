// Pure model for the shared memory-table grid (agent & memory UX WP-I; spec §8). NO React imports —
// vitest-pure like the workflow editor models. The grid component (TableGrid.tsx) renders from these;
// the filter mapping is index-based so a filtered view keeps editing against the ORIGINAL row/rowid.

/** The row indices (into the original rows array) whose cells match `query` — case-insensitive
 *  substring over every cell's string form. Blank query = all rows. Index-based so the caller maps
 *  back to `rowids[i]` for edits (filtering must never re-key the write path). */
export const filterRowIndices = (rows: unknown[][], query: string): number[] => {
  const q = query.trim().toLowerCase()
  const all = rows.map((_, i) => i)
  if (!q) return all
  return all.filter((i) =>
    rows[i].some((cell) => cell != null && String(cell).toLowerCase().includes(q))
  )
}

/** A table's maintenance-pointer state (mirrors readChatTablesStatus's per-table shape). */
export interface TableStatusLike {
  lastFloor: number | null
  processed: number
  nextExpected: number
  unprocessed: number
}

/** The maintenance-pointer marker for one table, as an i18n key + params (keyed patterns, never
 *  concatenated fragments — the cross-cutting i18n rule). `never` = no maintenance pass yet. */
export type PointerSpec =
  | { kind: 'never'; key: 'tables.progressNever' }
  | {
      kind: 'at'
      key: 'tables.pointerLine'
      params: { processed: number; next: number; unprocessed: number }
    }

export const pointerSpec = (status: TableStatusLike | null | undefined): PointerSpec => {
  if (status == null || status.lastFloor == null) return { kind: 'never', key: 'tables.progressNever' }
  return {
    kind: 'at',
    key: 'tables.pointerLine',
    params: {
      processed: status.processed,
      next: status.nextExpected,
      unprocessed: status.unprocessed
    }
  }
}

/** Column width hint (ch units) from the header + a sample of the data: clamp(min, longest-cell, max).
 *  Only a HINT — the table stays auto-layout; the hint feeds min/max-width so short id columns stay
 *  narrow and prose columns wrap instead of stretching the row (the "column autosizing" polish). */
export const columnWidthHint = (
  header: string,
  rows: unknown[][],
  colIndex: number,
  opts: { min?: number; max?: number; sample?: number } = {}
): number => {
  const { min = 6, max = 48, sample = 50 } = opts
  let longest = header.length
  const n = Math.min(rows.length, sample)
  for (let i = 0; i < n; i++) {
    const cell = rows[i][colIndex]
    if (cell == null) continue
    const len = String(cell).length
    if (len > longest) longest = len
  }
  return Math.max(min, Math.min(max, longest + 2))
}
