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

// ── Pagination (Memory Manager WP1) — OPT-IN for the shared grid. Pure so the page math is unit-tested
// and the component stays declarative. The Memory Manager's Data tab enables it (~30 rows/page); every
// other TableGrid host leaves it off and renders all rows exactly as before. ────────────────────────

/** Resolved paging state for one list: the clamped current page, the total page count (always ≥ 1 so
 *  the pager never disappears on an empty list), and the 1-based inclusive row range shown (`from`/`to`
 *  are 0 when the list is empty). `total` echoes the input count for the range label. */
export interface PageInfo {
  page: number
  pageCount: number
  from: number
  to: number
  total: number
}

/** Compute paging state for a list of `total` items at `page` (0-based) / `pageSize`. The requested
 *  page is clamped into range, so a shrinking filter can never strand the view past the last page. */
export const pageInfo = (total: number, page: number, pageSize: number): PageInfo => {
  const size = Math.max(1, Math.floor(pageSize))
  const count = Math.max(1, Math.ceil(Math.max(0, total) / size))
  const clamped = Math.min(Math.max(0, Math.floor(page)), count - 1)
  const from = total <= 0 ? 0 : clamped * size + 1
  const to = total <= 0 ? 0 : Math.min(total, (clamped + 1) * size)
  return { page: clamped, pageCount: count, from, to, total: Math.max(0, total) }
}

/** Slice the current page's items from a list, clamping the page the same way `pageInfo` does (so the
 *  slice and the displayed range/counts always agree). */
export const pageSlice = <T>(items: readonly T[], page: number, pageSize: number): T[] => {
  const size = Math.max(1, Math.floor(pageSize))
  const info = pageInfo(items.length, page, size)
  const start = info.page * size
  return items.slice(start, start + size)
}
