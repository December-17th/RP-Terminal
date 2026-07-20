import type { AgentDefinition } from '../../../../shared/agentRuntime'
import { MEMORY_MAINTENANCE_AGENT_NAME } from '../memoryMaintenanceSlot'

/**
 * The `Classic Narrator` and `Yuzu Scene Director` built-ins were DECOYS: seeded into every profile,
 * role-bound, and displayed in the Workspace, but never read by generation — Classic's prompt comes from
 * `generation/classicTurn.ts`, and Yuzu rides the same direct path via `vnMode` (ADR 0008/0019), not a
 * catalog Agent. Execution-plan M5a (decision D6 = migrate away) stops seeding them and a profile-DB
 * migration (`db.ts` `migrateRemoveDecoyBuiltinAgents`) deletes any already-seeded rows and their role
 * bindings. The `classic.narrator` / `yuzu.sceneDirector` roles, the `agent_role_bindings` CHECK
 * constraint, and the card role-recommendation schema are KEPT — cards may still recommend roles.
 */

/**
 * The converted `memory.maintain` (execution-plan M4; parser-backed design §6). A tool-less, detached
 * SQL-table maintenance Agent, dispatched by the M3 floor-commit cadence trigger and gated internally
 * by the due-table check inside the main-side bridge (`memoryMaintenanceSlot.ts`). Deliberately NOT
 * role-bound (roles are CHECK-constrained to classic.narrator/yuzu.sceneDirector) — it is a background
 * Agent, never a player-facing turn Agent, so `required: false` (a failed pass is recoverable and must
 * not fail a barrier) and `blocksNextTurn: false`.
 *
 * `everyNFloors: 3` matches the default memory doc's `trigger.cadence` (defaultMemoryTemplate.ts:281);
 * `maxRetryAttempts: 5` maps the node's transient-empty-stream retry default (memoryNodes.ts:204).
 * The maintainer prompt is composed per-invocation by the bridge and substitutes for this placeholder
 * `prompt`, so the placeholder is only ever sent on the (near-impossible) compose-fallback path.
 */
export const MEMORY_MAINTENANCE: AgentDefinition = {
  format: 'rpt-agent',
  formatVersion: 1,
  name: MEMORY_MAINTENANCE_AGENT_NAME,
  description: 'Built-in background Agent that maintains the SQL memory tables after a floor commits.',
  prompt: [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'Maintain the memory tables from the recent transcript and reply with a <TableEdit> block.'
        }
      ]
    }
  ],
  inputSchema: { type: 'object' },
  result: { mode: 'text' },
  tools: [],
  trigger: { onFloorCommitted: { everyNFloors: 3 } },
  defaults: {
    required: false,
    maxSteps: 1,
    maxRetryAttempts: 5,
    retryDelayMs: 5000,
    blocksNextTurn: false,
    toolResultMaxTokens: 10000,
    notification: 'failure'
  }
}

export const BUILTIN_AGENTS = [
  { key: 'memory-maintenance', definition: MEMORY_MAINTENANCE }
] as const

/** The retired decoy source keys — the migration deletes any rows still carrying them (D6). */
export const RETIRED_BUILTIN_KEYS = ['classic-narrator', 'yuzu-scene-director'] as const
