import { describe, it, expect, vi, beforeEach } from 'vitest'

// table-refill WS2 — the on-demand APPEND "run maintenance now" body (maintainNow/composeMaintainNowMessages)
// is RETIRED (it double-counted overlapping floors — the duplicate-rows bug). The `chat-tables-maintain-now`
// IPC now starts a chunk-committed REFILL (tableRefillService). Only `resolveMaintainConfig` survives in
// tableMaintainNow — it still backs the Maintenance-tab prompt preview — so this pins JUST that resolver.
// The refill engine's own decisions are unit-tested in test/tableRefill.test.ts.

// The config resolver reads the chat's effective memory.maintain node config from here.
const mockWorkflow = vi.hoisted(() => ({ resolveEffectiveDoc: vi.fn() }))
vi.mock('../../src/main/services/workflowService', () => mockWorkflow)

import { resolveMaintainConfig } from '../../src/main/services/tableMaintainNow'

const docWith = (config: unknown): unknown => ({
  id: 'w',
  doc: { nodes: [{ id: 'maintain', type: 'memory.maintain', config }] },
  warnings: []
})

const APPLY_CONFIG = {
  messages: [
    { role: 'system', content: '维护AI。\n【表格与规则】\n{{tables}}' },
    { role: 'user', content: '请根据以下对话维护表格：\n{history}' }
  ],
  lastNFloors: 6,
  advance_progress: true
}

beforeEach(() => {
  mockWorkflow.resolveEffectiveDoc.mockReset().mockReturnValue(docWith(APPLY_CONFIG))
})

describe('resolveMaintainConfig — the surviving Maintenance-tab preview resolver', () => {
  it('reads the effective doc memory.maintain node config', () => {
    expect(resolveMaintainConfig('prof', 'c1')?.lastNFloors).toBe(6)
  })

  it('returns null when the resolved doc has no memory.maintain node', () => {
    mockWorkflow.resolveEffectiveDoc.mockReturnValue({ id: 'w', doc: { nodes: [] }, warnings: [] })
    expect(resolveMaintainConfig('prof', 'c1')).toBeNull()
  })
})
