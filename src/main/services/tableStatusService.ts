import { getChatTableTemplateId } from './chatService'
import { getTableTemplateById } from './tableTemplateService'
import { getFloorCount } from './floorService'
import {
  getProgress,
  computeTableProgress,
  resolveUpdateFrequency,
  TableProgress
} from './tableProgressService'
import { getSettings } from './settingsService'
import { TableTemplate } from '../types/tableTemplate'

// Re-export the pure resolver so the documented API surface stays on tableStatusService. Its
// DEFINITION lives in the leaf `tableProgressService` so `table.gate` / `table.read` / backfill can
// import it without pulling in this module's `workflowService` dep (which would form an import cycle).
export { resolveUpdateFrequency }

/**
 * Per-table maintenance-progress status for the Tables view (issue 06 → repurposed in issue 07).
 *
 * The last-processed pointer lives in the chat-level `table_progress` store (`tableProgressService`),
 * shared by the per-turn `table.gate` cadence AND the manual backfill. `chat-tables-status` reads that
 * store, joins it with each table's EFFECTIVE update frequency + the chat's current floor count, and
 * returns the three display numbers per table (已处理 / 下次维护 / 未处理).
 *
 * EFFECTIVE frequency: a `table.gate` node may carry the global cadence override `config.every`
 * (post-merge fix — see the gate's docstring), which replaces the template's per-table frequencies for
 * the tables that gate watches. The status must predict "下次维护" with the SAME rule the gate fires
 * on, so it scans the chat's resolved workflow for table.gate configs and applies the overrides
 * (`effectiveFrequencies`, pure + tested). Gates inside referenced sub-graphs are not scanned (same
 * scope the previous node-state scan had).
 */

/** One table's status line for the view: its raw last-processed floor + the derived display numbers. */
export interface TableStatus extends TableProgress {
  /** The last floor index this table was processed through; null = never processed. */
  lastFloor: number | null
  /** true when the table is EXCLUDED from auto-maintenance (authored updateFrequency 0). When set,
   *  `nextExpected` is -1 (never) and the gate skips the table. */
  off?: boolean
}

/** The gate-config fields the status cares about. */
export interface GateConfigView {
  tables?: string
  every?: number
}

/**
 * PURE (unit-tested): each table's EFFECTIVE update frequency — the template's own value (resolved
 * against `globalDefault` via `resolveUpdateFrequency`: `-1` → the global default, `0` → OFF) unless a
 * gate's `every` override covers the table (an unfiltered gate covers every table; a `tables`-filtered
 * gate covers only its list). With several overriding gates covering one table, the LOWEST `every`
 * wins (the soonest gate fires first, so it drives "下次维护").
 *
 * An OFF table (authored `0`) is OMITTED from the map — no cadence, never due. A gate `every` override
 * still applies to a watched OFF table (the workflow author's explicit override re-includes it), matching
 * the `table.gate` `every`-overrides-everything contract.
 */
export const effectiveFrequencies = (
  template: TableTemplate,
  gates: GateConfigView[],
  globalDefault: number
): Record<string, number> => {
  const out: Record<string, number> = {}
  const known = new Set<string>()
  for (const t of template.tables) {
    known.add(t.sqlName)
    const resolved = resolveUpdateFrequency(t.updateFrequency, globalDefault)
    if (resolved != null) out[t.sqlName] = resolved // null (off) → omitted
  }
  // Overrides REPLACE the template value (that's the gate's semantics), so they min only among
  // THEMSELVES — min-ing against the template default would let a freq-1 table beat an every-5
  // override and mispredict 下次维护. An override can re-include an OFF table (explicit author intent).
  const overrides: Record<string, number> = {}
  for (const gate of gates) {
    if (gate.every == null) continue
    const watch = (gate.tables ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const covered = watch.length ? watch.filter((n) => known.has(n)) : Array.from(known)
    for (const name of covered) {
      overrides[name] = Math.min(overrides[name] ?? Infinity, gate.every)
    }
  }
  return { ...out, ...overrides }
}

/** Gate-config overrides no longer exist (execution-plan M5c-2: the `table.gate` workflow node and the
 *  whole workflow surface are deleted), so there are never any overrides — the status uses each table's
 *  own effective frequency. Kept as a seam so `effectiveFrequencies` still receives its `gates` argument
 *  (empty), preserving its unit-tested pure contract. */
const gateConfigs = (_profileId: string, _chatId: string): GateConfigView[] => []

/**
 * Resolve the chat's assigned template, read the shared progress store, and compute per-table status
 * with the gates' effective frequencies. Returns `Record<sqlName, TableStatus>` for every table in the
 * template. No template → `{}` (the view shows nothing). Best-effort: any failure yields `{}`.
 */
export const getTablesStatus = (
  profileId: string,
  chatId: string
): Record<string, TableStatus> => {
  try {
    const templateId = getChatTableTemplateId(profileId, chatId)
    if (!templateId) return {}
    const template = getTableTemplateById(profileId, templateId)
    if (!template) return {}

    const progress = getProgress(profileId, chatId)
    const currentFloor = getFloorCount(profileId, chatId) - 1 // -1 for an empty chat
    const globalDefault = getSettings(profileId).tables?.default_update_frequency ?? 3
    const frequencies = effectiveFrequencies(template, gateConfigs(profileId, chatId), globalDefault)

    const out: Record<string, TableStatus> = {}
    for (const table of template.tables) {
      const last = progress[table.sqlName]
      const freq = frequencies[table.sqlName]
      // OFF (authored 0, no gate override re-including it): no cadence, never due. Report the raw
      // last-processed floor + the already-processed counts, but nextExpected = -1 (never).
      if (freq == null) {
        const processed = last == null ? 0 : last + 1
        out[table.sqlName] = {
          lastFloor: last ?? null,
          off: true,
          processed,
          nextExpected: -1,
          unprocessed: Math.max(0, currentFloor - (last ?? -1))
        }
        continue
      }
      out[table.sqlName] = {
        lastFloor: last ?? null,
        ...computeTableProgress(last, freq, currentFloor)
      }
    }
    return out
  } catch {
    return {}
  }
}
