import type { AgentDefinition } from '../../../../shared/agentRuntime'

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

export const BUILTIN_AGENTS = [
  { key: 'classic-narrator', definition: CLASSIC_NARRATOR },
  { key: 'yuzu-scene-director', definition: YUZU_SCENE_DIRECTOR }
] as const
