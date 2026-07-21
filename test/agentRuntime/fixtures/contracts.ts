export const MONTHLY_PROPERTY_AGENT = {
  format: 'rpt-agent',
  formatVersion: 1,
  name: 'Property Management',
  description: 'Calculates monthly property development.',
  prompt: [
    {
      role: 'system',
      content: "Update the player's properties using only supplied facts."
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Current properties:\n' },
        {
          type: 'binding',
          source: {
            type: 'variables',
            path: 'variables.stat_data.player.properties'
          }
        }
      ]
    }
  ],
  inputSchema: {
    type: 'object',
    required: ['month'],
    properties: {
      month: { type: 'number' }
    }
  },
  result: {
    mode: 'json',
    schema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string' }
      }
    },
    saveAs: 'variables.__rpt.agent_results.property.monthly'
  },
  tools: [],
  modelHint: 'a fast reasoning model',
  defaults: {
    required: true,
    maxSteps: 1,
    maxRetryAttempts: 5,
    retryDelayMs: 5000,
    blocksNextTurn: false,
    toolResultMaxTokens: 10000
  }
} as const

export const MONTHLY_WORLD_PLAN = {
  steps: [
    {
      agent: 'Property Management',
      input: {
        month: {
          source: {
            type: 'variables',
            path: 'variables.stat_data.world.month'
          }
        }
      }
    },
    {
      parallel: [{ agent: 'World Progression' }, { agent: 'Off-screen Relationships' }]
    }
  ]
} as const
