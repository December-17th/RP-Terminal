// Pure display-derivations for the Memory pane (agent-packs plan WP3.8 — the control-center Memory
// rail: the single home for memory CONFIGURATION + MAINTENANCE). Like agentExplain.ts /
// agentPackDisplay.ts, everything here is side-effect-free and React-free so it is unit-testable
// under Node (test/memoryPane.test.ts) — the pane renders these shapes and adds localized labels +
// DOM. The de-scatter mandate: template binding, per-table progress, and the manual backfill move OUT
// of the Tables workspace view (which stays the lean data grid) and INTO this pane; the derivations
// that decide "which state is the pane in" and "which packs are memory packs" live here.
//
// Grounding: the writes-tables capability id (shared/workflow/capabilities.ts — isWriteCapability),
// the TableStatus shape (readChatTablesStatus IPC, mirrored in TablesView), the gate map the Agents
// view already holds (AgentsView.gates).

import type { CapabilityId } from '../../../../shared/workflow/capabilities'

/** The memory capability: a pack that WRITES tables is the one whose usefulness depends on a table
 *  template being assigned. The Memory-pack shortcut strip and the memory-template checklist both key
 *  off this. One place to change the definition (mirrors OverviewPane's inline `writes-tables` check). */
export const MEMORY_CAPABILITY: CapabilityId = 'writes-tables'

/** Does this pack write tables (i.e. is it a "memory pack")? */
export function isMemoryPack(capabilities: readonly CapabilityId[]): boolean {
  return capabilities.includes(MEMORY_CAPABILITY)
}

/** The minimal pack shape the memory-pack strip needs (a projection of AgentsView's PackSummary). */
export interface MemoryPackInput {
  id: string
  name: string
  capabilities: readonly CapabilityId[]
}

/** One row in the Memory pane's "memory packs" shortcut strip: the pack + whether its gate is open for
 *  the active world. Clicking it jumps to the Installed detail (handled by the view via existing nav). */
export interface MemoryPackRow {
  id: string
  name: string
  /** true = gated open for the active world (from the Agents gate map). */
  enabled: boolean
}

/** The memory packs (writes-tables) with their resolved gate state, for the shortcut strip. Preserves
 *  input order (the installed-list order). Pure — the view supplies the pack projection + gate map. */
export function memoryPackRows(
  packs: readonly MemoryPackInput[],
  gates: Record<string, boolean>
): MemoryPackRow[] {
  return packs
    .filter((p) => isMemoryPack(p.capabilities))
    .map((p) => ({ id: p.id, name: p.name, enabled: gates[p.id] ?? false }))
}

// ── Which state is the pane in? ──────────────────────────────────────────────────────────────────
//
// The pane has three top-level states, decided purely from two cheap facts (is there an active chat,
// and does that chat have a table template assigned). The view fetches those facts and renders the
// matching layout; keeping the decision here means the empty/no-template/configured states are pinned
// by tests, not re-derived ad hoc in JSX.

/** The Memory pane's top-level display mode. */
export type MemoryPaneMode =
  /** No active chat/world — nothing to configure yet (the invitational empty state). */
  | 'no-chat'
  /** A chat, but no table template assigned — memory is off; the pane leads with the binding control. */
  | 'no-template'
  /** A template is assigned — the full config + maintenance surface. */
  | 'configured'

/** Decide the pane mode from the two cheap facts. Pure. */
export function memoryPaneMode(args: { hasChat: boolean; hasTemplate: boolean }): MemoryPaneMode {
  if (!args.hasChat) return 'no-chat'
  return args.hasTemplate ? 'configured' : 'no-template'
}

// ── Per-table maintenance summary ─────────────────────────────────────────────────────────────────
//
// The per-table progress numbers (processed / unprocessed / next-expected) come straight from the
// readChatTablesStatus IPC (TableStatus). The pane also wants a ONE-LINE roll-up across all tables for
// the maintenance header ("N floors unprocessed across M tables") so the user sees at a glance whether
// a backfill is worth running. This is the only aggregate; per-table numbers stay per-table.

/** The per-table status shape (mirrors TablesView.TableStatus / the readChatTablesStatus payload). */
export interface TableStatusLike {
  lastFloor: number | null
  processed: number
  nextExpected: number
  unprocessed: number
}

export interface MaintenanceSummary {
  /** How many tables the status map covers. */
  tableCount: number
  /** The MAX unprocessed count across tables (the backlog the next backfill would clear). */
  maxUnprocessed: number
  /** true when at least one table has an unprocessed backlog (→ suggest a backfill). */
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
