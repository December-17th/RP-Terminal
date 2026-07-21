export const cardAgentTransportFixture = {
  name: 'Monthly Property',
  input: { month: 7, properties: [{ id: 'inn', income: 12 }] },
  floor: 12,
  plan: { floor: 12, steps: [{ agent: 'Monthly Property', input: { month: 7 } }] },
  tool: {
    name: 'clock',
    inputSchema: { type: 'object' },
    transactionMode: 'transactional' as const,
    parallelSafe: false
  },
  commit: { floor: 12, variables: { month: 7 }, previousVariables: { month: 6 } }
} as const