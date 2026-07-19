import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pins the invariant M3 relies on: the floor-commit trigger event (emitCardFloorCommitted) fires ONLY
// for a genuinely new floor. A replay / re-incorporation writes through a DIFFERENT path that does not
// call emitCardFloorCommitted, and saveFloor reports isNewFloor=false for an overwrite — so a triggered
// Agent never fires on replay. Driven through the REAL chatService.appendFloor + the REAL
// cardAgentEvents bus, with only the DB-bound seams mocked.

const saveFloorCallback = { current: null as ((isNewFloor: boolean) => void) | null }

vi.mock('../../src/main/services/db', () => ({
  getDb: () => ({ prepare: () => ({ run: vi.fn(), get: () => undefined, all: () => [] }) }),
  transact: (fn: () => unknown) => fn()
}))
vi.mock('../../src/main/services/floorService', () => ({
  saveFloor: vi.fn((_p: string, _c: string, _f: unknown, cb?: (isNewFloor: boolean) => void) => {
    saveFloorCallback.current = cb ?? null
  }),
  getFloor: vi.fn(() => undefined),
  deleteFloorAndSubsequent: vi.fn(),
  updateFloorFields: vi.fn(),
  refreshChatSummary: vi.fn()
}))
vi.mock('../../src/main/services/sessionDbService', () => ({
  getSessionDbByChat: () => null
}))
vi.mock('../../src/main/services/tableTemplateService', () => ({
  getTableTemplateById: vi.fn(() => null)
}))
vi.mock('../../src/main/services/tableDbService', () => ({
  instantiate: vi.fn(),
  removeSandbox: vi.fn(),
  removeShadow: vi.fn()
}))

import { appendFloor } from '../../src/main/services/chatService'
import { onCardFloorCommitted } from '../../src/main/services/agentRuntime/cardAgentEvents'
import type { FloorFile } from '../../src/main/types/chat'

const floorFile = (floor: number): FloorFile => ({
  floor,
  chat_id: 'chat',
  timestamp: 'now',
  user_message: { content: '', timestamp: 'now' },
  response: { content: 'reply', model: '', provider: 'test' },
  events: [],
  variables: { stat_data: { hp: floor } }
})

describe('floor-commit emit guard (replay/re-incorporation do not fire triggers)', () => {
  beforeEach(() => {
    saveFloorCallback.current = null
  })

  it('emits the floor-commit event only when saveFloor reports a genuinely new floor', () => {
    const events: number[] = []
    const off = onCardFloorCommitted((_p, _c, event) => events.push(event.floor))
    try {
      appendFloor('p', 'chat', floorFile(4))
      // A brand-new floor commit.
      saveFloorCallback.current?.(true)
      // A replay/overwrite of the same floor — saveFloor reports it is NOT new.
      appendFloor('p', 'chat', floorFile(4))
      saveFloorCallback.current?.(false)

      expect(events).toEqual([4]) // exactly one emit — the new-floor commit, never the replay
    } finally {
      off()
    }
  })
})
