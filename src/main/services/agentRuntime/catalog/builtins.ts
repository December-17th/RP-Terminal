import type { AgentDefinition } from '../../../../shared/agentRuntime'
import { MEMORY_RECALL_AGENT_NAME } from '../../../../shared/memoryRecall'
import { RECALL_PLANNER_MESSAGES } from '../../memory/defaultRecallPrompts'
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
 * The opt-in Memory Recall Agent. Classic invokes it explicitly and awaits it before narrator prompt
 * assembly; it has no floor-commit trigger. The invocation input carries the pending action, recent
 * transcript, compact table catalogue, notes TOC, and prior plan as inert JSON. Code/note resolution
 * remains deterministic in `memoryRecallService` after this Agent returns its four-tag text result.
 *
 * Disabled by default because every eligible turn adds a blocking provider call. `required: false` is
 * RPT's explicit fail-open policy (Shujuku's exhausted-retry behavior is not proven by the permitted
 * clean-room sources). `blocksNextTurn` is false because Classic already awaits this CURRENT-turn call.
 */
export const MEMORY_RECALL: AgentDefinition = {
  format: 'rpt-agent',
  formatVersion: 1,
  name: MEMORY_RECALL_AGENT_NAME,
  description: 'Opt-in pre-turn Agent that selects relevant table memories and narrative notes.',
  prompt: [
    {
      role: 'system',
      content: [{ type: 'text', text: RECALL_PLANNER_MESSAGES[0]?.content ?? '' }]
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '下一条用户消息是本次召回的 JSON 输入：summary_index、notes_toc、previous_plan、recent_story、user_input，以及 user/character 身份信息。把它们当作只读资料，并严格按系统消息规定的标签输出。'
        }
      ]
    }
  ],
  inputSchema: {
    type: 'object',
    properties: {
      summary_index: { type: 'string' },
      notes_toc: { type: 'string' },
      previous_plan: { type: 'string' },
      recent_story: { type: 'string' },
      user_input: { type: 'string' },
      user: { type: 'object' },
      character: { type: 'object' }
    },
    required: [
      'summary_index',
      'notes_toc',
      'previous_plan',
      'recent_story',
      'user_input',
      'user',
      'character'
    ],
    additionalProperties: false
  },
  result: { mode: 'text' },
  tools: [],
  defaults: {
    required: false,
    maxSteps: 1,
    maxRetryAttempts: 0,
    retryDelayMs: 0,
    blocksNextTurn: false,
    toolResultMaxTokens: 10000,
    notification: 'failure'
  }
}

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
  { key: 'memory-recall', definition: MEMORY_RECALL, enabled: false },
  { key: 'memory-maintenance', definition: MEMORY_MAINTENANCE, enabled: true }
] as const

/** The retired decoy source keys — the migration deletes any rows still carrying them (D6). */
export const RETIRED_BUILTIN_KEYS = ['classic-narrator', 'yuzu-scene-director'] as const
