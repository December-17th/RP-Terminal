import { getChatTableTemplateId } from './chatService'
import { getTableTemplateById } from './tableTemplateService'
import { getAllFloors } from './floorService'
import { getProgress, computeTableProgress, TableProgress } from './tableProgressService'

/**
 * Per-table maintenance-progress status for the Tables view (issue 06 → repurposed in issue 07).
 *
 * The last-processed pointer now lives in the chat-level `table_progress` store (`tableProgressService`),
 * shared by the per-turn `table.gate` cadence AND the manual backfill. `chat-tables-status` reads that
 * store, joins it with the assigned template's per-table update frequencies + the chat's current floor
 * count, and returns the three display numbers per table (已处理 / 下次维护 / 未处理). The old
 * workflow/node-state scanning (`mergeLastMaintained`) is retired with the node-state pointer.
 */

/** One table's status line for the view: its raw last-processed floor + the derived display numbers. */
export interface TableStatus extends TableProgress {
  /** The last floor index this table was processed through; null = never processed. */
  lastFloor: number | null
}

/**
 * Resolve the chat's assigned template, read the shared progress store, and compute per-table status.
 * Returns `Record<sqlName, TableStatus>` for every table in the template. No template → `{}` (the view
 * shows nothing). Best-effort: any failure yields `{}`.
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

    const out: Record<string, TableStatus> = {}
    for (const table of template.tables) {
      const last = progress[table.sqlName]
      out[table.sqlName] = {
        lastFloor: last ?? null,
        ...computeTableProgress(last, table.updateFrequency, currentFloor)
      }
    }
    return out
  } catch {
    return {}
  }
}
