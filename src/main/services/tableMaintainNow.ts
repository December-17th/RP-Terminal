import { z } from 'zod'
import { resolveEffectiveDoc } from './workflowService'
import { memoryMaintainConfig } from './nodes/builtin/memoryNodes'

/**
 * Resolve the chat's effective `memory.maintain` node config — the exact maintainer config an automatic
 * pass runs. Shared by the Memory-Manager Maintenance-tab prompt PREVIEW (`memory-maintain-preview`) so
 * the preview matches a real turn's maintainer prompt.
 *
 * NOTE (table-refill WS2): the old on-demand APPEND "run maintenance now" body that lived here is RETIRED
 * — it appended onto the current tables, double-counting overlapping floors (the duplicate-rows bug). Its
 * only caller, the `chat-tables-maintain-now` IPC, now starts a chunk-committed REFILL
 * (`tableRefillService.startRefill` via `chat-tables-refill`). Only this config resolver survives.
 */

type MemoryMaintainConfig = z.infer<typeof memoryMaintainConfig>

/**
 * Resolve the chat's effective `memory.maintain` node config. Returns null when the resolved doc has no
 * `memory.maintain` node (or its config is malformed).
 */
export const resolveMaintainConfig = (
  profileId: string,
  chatId: string
): MemoryMaintainConfig | null => {
  const { doc } = resolveEffectiveDoc(profileId, chatId)
  const node = doc.nodes.find((n) => n.type === 'memory.maintain')
  if (!node) return null
  const parsed = memoryMaintainConfig.safeParse(node.config ?? {})
  return parsed.success ? parsed.data : null
}
