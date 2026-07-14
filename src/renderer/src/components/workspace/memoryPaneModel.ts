// Pure maintenance-summary derivation for the memory surfaces. TRIMMED in table-refill WS6 Phase B:
// this file once carried the whole control-center Memory pane's display model (pane mode, memory-pack
// strip — agent-packs WP3.8), but that pane (MemoryPane.tsx) is deleted — the Memory Manager's Refill
// workbench absorbed the per-table progress display (picker badges) and the rail's ⋯ menu absorbed the
// template file-ops. What remains is the ONE aggregate two hosts still need: the roll-up the TopStrip
// memory chip (记忆 · N) and any summary line derive from the readChatTablesStatus payload. Pure,
// React-free, pinned by test/memoryPane.test.ts.

/** The per-table status shape (mirrors the readChatTablesStatus IPC payload). */
export interface TableStatusLike {
  lastFloor: number | null
  processed: number
  nextExpected: number
  unprocessed: number
}

export interface MaintenanceSummary {
  /** How many tables the status map covers. */
  tableCount: number
  /** The MAX unprocessed count across tables (the backlog a refill would clear). */
  maxUnprocessed: number
  /** true when at least one table has an unprocessed backlog. */
  hasBacklog: boolean
}

/** Roll the per-table status map up into a one-line maintenance summary. Pure. */
export function maintenanceSummary(status: Record<string, TableStatusLike>): MaintenanceSummary {
  const entries = Object.values(status)
  const maxUnprocessed = entries.reduce((m, s) => Math.max(m, s.unprocessed), 0)
  return {
    tableCount: entries.length,
    maxUnprocessed,
    hasBacklog: maxUnprocessed > 0
  }
}
