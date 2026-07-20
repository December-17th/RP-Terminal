import fs from 'fs'
import path from 'path'
import { getDb } from './db'
import { log } from './logService'
import { getAppDir, readJsonSync, listFilesSync } from './storageService'
import { AgentCatalog } from './agentRuntime/catalog'
import { MEMORY_MAINTENANCE_AGENT_NAME } from './agentRuntime/memoryMaintenanceSlot'
import { DEFAULT_MEMORY_MAINTAIN_CONFIG } from './memory/maintainerDefaults'

/**
 * The OLD workflow-doc memory-group settings, read straight off disk by NODE TYPE — the one-time seed
 * source (execution-plan M5b2, task A). Relocated here from `workflowService` (execution-plan M5c,
 * SURVIVOR NOTE) as a self-contained LEGACY-FILE READER: it reads the pre-existing `.json` docs under
 * `profiles/<id>/workflows/` as plain JSON — NO workflow-model imports, NO doc validation, NO lazy
 * seed — so the seed keeps working after the workflow surface is deleted while Legacy Workflow Data on
 * disk stays inert (ADR 0020).
 *
 * Returns the first doc carrying a memory group's exposed settings: cadence (`trigger.cadence`
 * everyNFloors), mode (`control.mode` selected — 'every_turn' | 'async' | 'off'), API preset
 * (`memory.maintain` api_preset_id), and the raw `memory.maintain` node config (`maintainConfig`) — the
 * scaffold/lastNFloors/max_rows/etc. the M5c-1 scaffold re-home overlays. `null` when the profile has no
 * doc with any memory-group node.
 */
interface LegacyNode {
  type?: unknown
  config?: unknown
}
interface LegacyMemorySettings {
  everyNFloors?: number
  mode?: string
  apiPresetId?: string
  maintainConfig?: Record<string, unknown>
}
const readMemoryGroupSettings = (profileId: string): LegacyMemorySettings | null => {
  const dir = path.join(getAppDir(), 'profiles', profileId, 'workflows')
  if (!fs.existsSync(dir)) return null
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const data = readJsonSync<{ nodes?: unknown }>(path.join(dir, file))
    if (!data || !Array.isArray(data.nodes)) continue
    const nodes = data.nodes as LegacyNode[]
    const maintain = nodes.find((n) => n?.type === 'memory.maintain')
    const cadence = nodes.find((n) => n?.type === 'trigger.cadence')
    const mode = nodes.find((n) => n?.type === 'control.mode')
    // Not a memory doc (none of the group's nodes) → keep scanning.
    if (!maintain && !cadence && !mode) continue
    const out: LegacyMemorySettings = {}
    const everyN = (cadence?.config as { everyNFloors?: unknown } | undefined)?.everyNFloors
    if (typeof everyN === 'number' && Number.isFinite(everyN)) out.everyNFloors = everyN
    const selected = (mode?.config as { selected?: unknown } | undefined)?.selected
    if (typeof selected === 'string') out.mode = selected
    const apiPreset = (maintain?.config as { api_preset_id?: unknown } | undefined)?.api_preset_id
    if (typeof apiPreset === 'string' && apiPreset.trim()) out.apiPresetId = apiPreset.trim()
    if (maintain?.config && typeof maintain.config === 'object') {
      out.maintainConfig = maintain.config as Record<string, unknown>
    }
    return out
  }
  return null
}

/**
 * The maintainer-config fields the scaffold re-home overlays (execution-plan M5c-1). `api_preset_id` is
 * excluded — it re-homes onto the invocation config's `apiPresetId`, not the maintain override. Returns
 * only the fields whose value DIFFERS from the built-in default, so a pristine legacy doc seeds nothing.
 */
const OVERRIDE_FIELDS = [
  'messages',
  'lastNFloors',
  'max_rows',
  'include_rules',
  'advance_progress',
  'temperature',
  'stream',
  'retries',
  'retry_delay_s',
  'fallback_preset_id',
  'validator',
  'validator_pattern',
  'validator_retries',
  'corrective_nudge'
] as const
const nonDefaultMaintainOverride = (
  raw: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (!raw) return undefined
  const out: Record<string, unknown> = {}
  const def = DEFAULT_MEMORY_MAINTAIN_CONFIG as unknown as Record<string, unknown>
  for (const key of OVERRIDE_FIELDS) {
    if (!(key in raw)) continue
    if (JSON.stringify(raw[key]) !== JSON.stringify(def[key])) out[key] = raw[key]
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * One-time settings SEED for pre-existing profiles (execution-plan M5b2, task A).
 *
 * M5b re-homed the memory-maintenance settings off the OLD workflow-doc memory group onto the built-in
 * Memory Maintenance Agent: cadence → the Agent's `trigger.onFloorCommitted.everyNFloors`, the off-switch
 * → the Agent's `enabled` flag, and the API preset → the profile-local invocation config. A profile that
 * had customized the OLD doc group (cadence via the `trigger.cadence` node, mode via `control.mode`, API
 * preset via the `memory.maintain` node) must NOT silently lose those choices when the new dispatch stops
 * reading the doc. This copies those non-default values across, ONCE per profile.
 *
 * IDEMPOTENCY marker: the `profiles.memory_settings_seeded` column (0 = pending, 1 = done) — the same
 * per-entity marker precedent as `chats.session_migrated`, NOT a parallel mechanism. Marked done on first
 * run regardless of outcome (fail-forward: a broken read never re-runs every profile open), mirroring the
 * lazy default-memory seeder which marks before doing its work.
 *
 * NON-OVERWRITE rule: if the user already edited the Agent (a customization exists, or they disabled it,
 * or they already set an invocation-config API preset — all only reachable through the new M5b surface),
 * the seed copies NOTHING and just marks done. It only ever seeds a pristine built-in.
 */
export const seedMemoryMaintenanceSettings = (profileId: string): void => {
  const db = getDb()
  const row = db
    .prepare('SELECT memory_settings_seeded AS seeded FROM profiles WHERE id = ?')
    .get(profileId) as { seeded: number } | undefined
  // Unknown profile, or already seeded → nothing to do (survives restarts via the DB marker).
  if (!row || row.seeded === 1) return

  try {
    const catalog = new AgentCatalog(profileId, db)
    const agent = catalog.get(MEMORY_MAINTENANCE_AGENT_NAME)
    // The built-in seeds in the AgentCatalog constructor; a missing row means nothing to seed onto.
    if (agent) {
      // Any prior user edit to the Agent (definition customization / disabled / a set API preset) is a
      // deliberate choice — never clobber it. Mark done without copying.
      const userEdited =
        agent.customized || !agent.enabled || !!agent.invocationConfig.apiPresetId
      if (!userEdited) {
        const settings = readMemoryGroupSettings(profileId)
        if (settings) {
          // mode 'off' → disable the Agent (the trigger runtime skips a disabled Agent entirely).
          if (settings.mode === 'off') catalog.setEnabled(agent.id, false)
          // Invocation config (never exported; read by the dispatch/bridge): the API preset AND the
          // NON-DEFAULT maintainer-scaffold override (M5c-1 scaffold re-home part 2). Written in ONE
          // call so neither field clobbers the other; skipped entirely when both are empty.
          const maintainOverride = nonDefaultMaintainOverride(settings.maintainConfig)
          if (settings.apiPresetId || maintainOverride) {
            catalog.setInvocationConfig(agent.id, {
              ...(settings.apiPresetId ? { apiPresetId: settings.apiPresetId } : {}),
              ...(maintainOverride ? { maintain: maintainOverride } : {})
            })
          }
          // cadence → the Agent's floor-commit trigger, only when it differs from the built-in default.
          const currentCadence = agent.effective.trigger?.onFloorCommitted?.everyNFloors
          if (
            typeof settings.everyNFloors === 'number' &&
            settings.everyNFloors >= 1 &&
            settings.everyNFloors !== currentCadence
          ) {
            const effective = agent.effective
            catalog.edit(agent.id, {
              ...effective,
              trigger: {
                ...(effective.trigger ?? {}),
                onFloorCommitted: {
                  ...(effective.trigger?.onFloorCommitted ?? {}),
                  everyNFloors: settings.everyNFloors
                }
              }
            })
          }
        }
      }
    }
  } catch (cause) {
    log(
      'error',
      `seedMemoryMaintenanceSettings failed for profile ${profileId} — ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }

  // Mark done regardless (fail-forward). A failed read/copy is logged, never retried on every open.
  db.prepare('UPDATE profiles SET memory_settings_seeded = 1 WHERE id = ?').run(profileId)
}
