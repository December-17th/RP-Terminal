import { getDb } from './db'
import { log } from './logService'
import { readMemoryGroupSettings } from './workflowService'
import { AgentCatalog } from './agentRuntime/catalog'
import { MEMORY_MAINTENANCE_AGENT_NAME } from './agentRuntime/memoryMaintenanceSlot'

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
          // API preset → the profile-local invocation config (never exported; read by the dispatch).
          if (settings.apiPresetId) {
            catalog.setInvocationConfig(agent.id, { apiPresetId: settings.apiPresetId })
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
