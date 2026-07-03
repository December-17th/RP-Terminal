import { getChatTableTemplateId } from './chatService'
import { getTableTemplateById } from './tableTemplateService'
import { getAllFloors } from './floorService'
import { resolveWorkflowDoc } from './workflowService'
import { getProgress, computeTableProgress, TableProgress } from './tableProgressService'
import { TableTemplate } from '../types/tableTemplate'

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
}

/** The gate-config fields the status cares about. */
export interface GateConfigView {
  tables?: string
  every?: number
}

/**
 * PURE (unit-tested): each table's EFFECTIVE update frequency — the template's own value unless a
 * gate's `every` override covers the table (an unfiltered gate covers every table; a `tables`-filtered
 * gate covers only its list). With several overriding gates covering one table, the LOWEST `every`
 * wins (the soonest gate fires first, so it drives "下次维护").
 */
export const effectiveFrequencies = (
  template: TableTemplate,
  gates: GateConfigView[]
): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const t of template.tables) out[t.sqlName] = t.updateFrequency
  // Overrides REPLACE the template value (that's the gate's semantics), so they min only among
  // THEMSELVES — min-ing against the template default would let a freq-1 table beat an every-5
  // override and mispredict 下次维护.
  const overrides: Record<string, number> = {}
  for (const gate of gates) {
    if (gate.every == null) continue
    const watch = (gate.tables ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const covered = watch.length ? watch.filter((n) => n in out) : Object.keys(out)
    for (const name of covered) {
      overrides[name] = Math.min(overrides[name] ?? Infinity, gate.every)
    }
  }
  return { ...out, ...overrides }
}

/** The chat's resolved workflow's table.gate configs (best-effort; [] on any failure). */
const gateConfigs = (profileId: string, chatId: string): GateConfigView[] => {
  try {
    const { doc } = resolveWorkflowDoc(profileId, chatId)
    return doc.nodes
      .filter((n) => n.type === 'table.gate')
      .map((n) => (n.config ?? {}) as GateConfigView)
  } catch {
    return []
  }
}

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
    const currentFloor = getAllFloors(profileId, chatId).length - 1 // -1 for an empty chat
    const frequencies = effectiveFrequencies(template, gateConfigs(profileId, chatId))

    const out: Record<string, TableStatus> = {}
    for (const table of template.tables) {
      const last = progress[table.sqlName]
      out[table.sqlName] = {
        lastFloor: last ?? null,
        ...computeTableProgress(
          last,
          frequencies[table.sqlName] ?? table.updateFrequency,
          currentFloor
        )
      }
    }
    return out
  } catch {
    return {}
  }
}
