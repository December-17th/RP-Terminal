import type { z } from 'zod'
import { AgentCatalog } from '../agentRuntime/catalog'
import { getDb } from '../db'
import { MEMORY_MAINTENANCE_AGENT_NAME } from '../agentRuntime/memoryMaintenanceSlot'
import { memoryMaintainConfig } from './maintainerCompose'
import { DEFAULT_MEMORY_MAINTAIN_CONFIG } from './maintainerDefaults'
import { log } from '../logService'

type MemoryMaintainConfig = z.infer<typeof memoryMaintainConfig>

/**
 * The effective Table-memory MAINTAINER config (execution-plan M5c-1 scaffold re-home, centralized in
 * M5c-2): the BUILT-IN default overlaid with the built-in Memory Maintenance Agent's profile-local
 * `invocation_config.maintain` override. `null` only when the merged config fails schema validation (a
 * corrupt override) — the default alone is always valid. Shared by the trigger dispatch bridge AND the
 * `memory-maintain-preview` IPC so the preview matches a real run byte-for-byte. No workflow surface is
 * touched (the old `resolveEffectiveDoc` read is gone with the doc).
 */
export const resolveEffectiveMaintainConfig = (profileId: string): MemoryMaintainConfig | null => {
  let override: Record<string, unknown> = {}
  try {
    const agent = new AgentCatalog(profileId, getDb()).get(MEMORY_MAINTENANCE_AGENT_NAME)
    override = agent?.invocationConfig.maintain ?? {}
  } catch (cause) {
    log(
      'error',
      `Memory Maintenance override read failed — ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  const parsed = memoryMaintainConfig.safeParse({ ...DEFAULT_MEMORY_MAINTAIN_CONFIG, ...override })
  return parsed.success ? parsed.data : null
}
