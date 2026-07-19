import type { AgentDefinition } from '../../../../shared/agentRuntime'
import { MEMORY_MAINTENANCE_AGENT_NAME } from '../memoryMaintenanceSlot'

export const CLASSIC_NARRATOR: AgentDefinition = {
  format: 'rpt-agent',
  formatVersion: 1,
  name: 'Classic Narrator',
  description: 'Built-in player-facing Agent for Classic chat generation.',
  prompt: [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'Continue the roleplay as the narrator using the assembled RP Terminal context.'
        }
      ]
    }
  ],
  inputSchema: { type: 'object' },
  result: { mode: 'text' },
  tools: [],
  defaults: {
    required: true,
    maxSteps: 1,
    maxRetryAttempts: 5,
    retryDelayMs: 5000,
    blocksNextTurn: false,
    toolResultMaxTokens: 10000,
    notification: 'failure'
  }
}

export const YUZU_SCENE_DIRECTOR: AgentDefinition = {
  format: 'rpt-agent',
  formatVersion: 1,
  name: 'Yuzu Scene Director',
  description: 'Built-in player-facing Agent for mixed narration and Yuzu Scene Script output.',
  prompt: [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'Continue the scene as narration and valid line-oriented Yuzu Scene Script.'
        }
      ]
    }
  ],
  inputSchema: { type: 'object' },
  result: { mode: 'text', validator: 'yss' },
  tools: [],
  defaults: {
    required: true,
    maxSteps: 1,
    maxRetryAttempts: 5,
    retryDelayMs: 5000,
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
  { key: 'classic-narrator', definition: CLASSIC_NARRATOR },
  { key: 'yuzu-scene-director', definition: YUZU_SCENE_DIRECTOR },
  { key: 'memory-maintenance', definition: MEMORY_MAINTENANCE }
] as const
