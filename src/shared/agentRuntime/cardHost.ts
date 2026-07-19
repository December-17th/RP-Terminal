export const CARD_AGENT_CHANNELS = {
  run: 'card-agent-run',
  runPlan: 'card-agent-run-plan',
  cancel: 'card-agent-cancel',
  registerTool: 'card-agent-tool-register',
  unregisterTool: 'card-agent-tool-unregister',
  toolRequest: 'wcv-agent-tool-request',
  toolResult: 'card-agent-tool-result',
  toolAbort: 'wcv-agent-tool-abort',
  floorCommitted: 'card-floor-committed'
} as const
