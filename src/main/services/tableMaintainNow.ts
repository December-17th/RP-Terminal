import { z } from 'zod'
import { memoryMaintainConfig } from './memory/maintainerCompose'
import { resolveEffectiveMaintainConfig } from './memory/maintainConfig'

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
 * Resolve the chat's effective maintainer config for the preview. As of M5c-2 this is the built-in
 * default ⊕ the Memory Maintenance Agent's profile-local override (the workflow doc is gone); `chatId`
 * is retained for the IPC signature but the config is profile-scoped. Returns null only on a corrupt
 * override (the default alone is always valid).
 */
export const resolveMaintainConfig = (
  profileId: string,
  _chatId: string
): MemoryMaintainConfig | null => resolveEffectiveMaintainConfig(profileId)
