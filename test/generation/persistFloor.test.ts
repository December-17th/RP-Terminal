import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * persistFloor's execution-record wiring (st-preset-compat issue 09). The floor-write path itself is
 * covered elsewhere; here we pin that persistFloor persists the record the assemble stage stamped onto
 * `gen` — with the resolved retention window — and skips cleanly when no record is present.
 */

const mockChat = vi.hoisted(() => ({ appendFloor: vi.fn() }))
vi.mock('../../src/main/services/chatService', () => mockChat)
const mockTemplates = vi.hoisted(() => ({ saveGlobals: vi.fn() }))
vi.mock('../../src/main/services/templateService', () => mockTemplates)
const mockStore = vi.hoisted(() => ({ saveExecutionRecord: vi.fn() }))
vi.mock('../../src/main/services/executionRecordStore', () => mockStore)

import { persistFloor } from '../../src/main/services/generation/persistFloor'
import { GenContext } from '../../src/main/services/generation/types'
import { ExecutionRecord } from '../../src/shared/executionRecord'

const record: ExecutionRecord = {
  version: 1,
  createdAt: '2026-07-17T00:00:00.000Z',
  entries: [],
  wire: [{ role: 'user', content: 'hi' }],
  stats: { entries: 0, bytes: 10, buildMs: 1 }
}

const ctx = (over: Partial<GenContext> = {}): GenContext =>
  ({
    profileId: 'p1',
    chatId: 'c1',
    userAction: 'hi',
    chat: { floor_count: 7 },
    settings: { api: { model: 'm', provider: 'openai' } },
    globals: {},
    ...over
  }) as unknown as GenContext

const args = {
  userAction: 'hi',
  raw: 'reply',
  sendMessages: [{ role: 'user', content: 'hi' }] as any,
  events: [],
  variables: {},
  metrics: {} as any
}

beforeEach(() => {
  mockChat.appendFloor.mockReset()
  mockTemplates.saveGlobals.mockReset()
  mockStore.saveExecutionRecord.mockReset()
})

describe('persistFloor — execution record persistence (issue 09)', () => {
  it('persists the stamped record keyed to the floor, with the resolved retention window', () => {
    persistFloor(
      ctx({
        executionRecord: record,
        settings: { api: { model: 'm', provider: 'openai' }, records: { retention: 12 } } as any
      }),
      args
    )
    expect(mockStore.saveExecutionRecord).toHaveBeenCalledWith('c1', 7, record, 12)
  })

  it('falls back to the default retention (50) when the setting is absent', () => {
    persistFloor(ctx({ executionRecord: record }), args)
    expect(mockStore.saveExecutionRecord).toHaveBeenCalledWith('c1', 7, record, 50)
  })

  it('skips record persistence when no record was stamped onto gen', () => {
    persistFloor(ctx(), args)
    expect(mockStore.saveExecutionRecord).not.toHaveBeenCalled()
    // the floor itself is still written
    expect(mockChat.appendFloor).toHaveBeenCalledTimes(1)
  })
})
