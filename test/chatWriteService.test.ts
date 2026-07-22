import { describe, it, expect, vi, beforeEach } from 'vitest'

// The chat-WRITE domain runs against a REAL per-chat session database.
//
// It used to run against a hand-rolled in-memory `floorService` mock, which made `floorStateForChat`
// null and so pinned a fallback branch (`floorService.saveFloor` per touched floor) that production
// could never reach: `floorStateForChat` is null ONLY when the chat has no row in the central index,
// and in that case `saveFloor` no-ops on the very same missing store. The fallback is gone, so the
// suite now observes the real thing — writes land through FloorState and are read back from SQLite.
//
// Harness: `test/mocks/betterSqlite3Node` (a better-sqlite3-shaped adapter over Node's `node:sqlite`)
// + the real `SESSION_SCHEMA`, injected by overriding `getSessionDbByChat`. `better-sqlite3` itself is
// deliberately NOT re-mocked, so the CENTRAL `getDb()` stays on the default no-op stub (the
// `refreshChatSummary` index update is irrelevant here and must not open a file on disk).

let sessionDb: InstanceType<typeof Adapter> | null = null

vi.mock('../src/main/services/sessionDbService', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/main/services/sessionDbService')>()
  return { ...actual, getSessionDbByChat: () => sessionDb }
})
vi.mock('../src/main/services/chatService', () => ({
  truncateFloors: vi.fn()
}))

import Adapter from './mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../src/main/services/sessionDbService'
import * as chatService from '../src/main/services/chatService'
import * as floorService from '../src/main/services/floorService'
import {
  setChatMessages,
  deleteChatMessages,
  saveChat,
  afterChatMutation
} from '../src/main/services/chatWriteService'

const addFloor = (floor: number, user: string, resp: string, swipes?: string[]): void => {
  sessionDb!
    .prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, response_content, events, variables, swipes, swipe_id)
       VALUES ('c', ?, '2026-07-22T00:00:00.000Z', ?, ?, '[]', '{"stat_data":{}}', ?, ?)`
    )
    .run(floor, user, resp, swipes ? JSON.stringify(swipes) : null, swipes ? 0 : null)
}

const stored = (): Array<{ floor: number; user_content: string; response_content: string }> =>
  sessionDb!
    .prepare('SELECT floor, user_content, response_content FROM floors WHERE chat_id = ? ORDER BY floor')
    .all('c') as never

/** Any FloorState publish that starts at floor 0 persists a baseline row — a cheap "a replay ran" probe. */
const replayed = (): boolean =>
  !!sessionDb!.prepare('SELECT 1 FROM floor_state_baselines WHERE chat_id = ?').get('c')

beforeEach(() => {
  vi.clearAllMocks()
  sessionDb = new Adapter(':memory:')
  sessionDb.exec(SESSION_SCHEMA)
})

describe('setChatMessages', () => {
  it('edits the mapped floor + role, persists it, and counts touched floors', () => {
    // compact map over [greeting(no user), turn]: 0={0,asst} 1={1,user} 2={1,asst}
    addFloor(0, '', 'greeting')
    addFloor(1, 'hi', 'hello')
    expect(setChatMessages('p', 'c', [{ message_id: 2, message: 'EDITED' }])).toBe(1)
    expect(stored()[1].response_content).toBe('EDITED')
    expect(stored()[0].response_content).toBe('greeting')
  })

  it('edits the user slot for a user-mapped index', () => {
    addFloor(0, '', 'g')
    addFloor(1, 'hi', 'hello')
    setChatMessages('p', 'c', [{ message_id: 1, message: 'newUser' }])
    expect(stored()[1].user_content).toBe('newUser')
  })

  it('skips out-of-range ids and non-string messages', () => {
    addFloor(0, '', 'g')
    expect(
      setChatMessages('p', 'c', [
        { message_id: 99, message: 'x' },
        { message_id: 0, message: 5 }
      ])
    ).toBe(0)
    expect(replayed()).toBe(false)
  })

  it('does NOT write the opening greeting onto a later floor response (stale card guard)', () => {
    // map: 0={0,asst} 1={1,user} 2={1,asst}. floor 0 = 'HOME'. A card echoing 'HOME' at id 2 must
    // not clobber floor 1's real reply. Writing 'HOME' back to id 0 (floor 0) is still allowed.
    addFloor(0, '', 'HOME')
    addFloor(1, 'u', 'realReply')
    expect(setChatMessages('p', 'c', [{ message_id: 2, message: 'HOME' }])).toBe(0)
    expect(stored()[1].response_content).toBe('realReply')
    expect(replayed()).toBe(false)
  })

  it('skips a message whose text is unchanged', () => {
    // A card re-rendering the same text must not count as an edit (no re-fold/reload chain).
    addFloor(0, '', 'greeting')
    expect(setChatMessages('p', 'c', [{ message_id: 0, message: 'greeting' }])).toBe(0)
    expect(replayed()).toBe(false)
  })

  it('counts (and writes) only floors that actually changed', () => {
    // map: 0={0,asst} 1={1,user} 2={1,asst}. Edit id 0 with identical text + id 2 with new text.
    addFloor(0, '', 'greeting')
    addFloor(1, 'hi', 'hello')
    expect(
      setChatMessages('p', 'c', [
        { message_id: 0, message: 'greeting' }, // unchanged
        { message_id: 2, message: 'EDITED' } // changed
      ])
    ).toBe(1)
    expect(stored()).toEqual([
      { floor: 0, user_content: '', response_content: 'greeting' },
      { floor: 1, user_content: 'hi', response_content: 'EDITED' }
    ])
    // The republish was bounded to the changed floor — it never restarted at floor 0.
    expect(replayed()).toBe(false)
  })
})

describe('deleteChatMessages', () => {
  it('truncates from the earliest targeted floor', () => {
    addFloor(0, '', 'g')
    addFloor(1, 'a', 'b')
    addFloor(2, 'c', 'd')
    // map: 0={0,asst} 1={1,user} 2={1,asst} 3={2,user} 4={2,asst} → ids 3,4 → earliest floor 2
    expect(deleteChatMessages('p', 'c', [4, 3])).toBe(true)
    expect(chatService.truncateFloors).toHaveBeenCalledWith('p', 'c', 2)
  })

  it('returns false (no truncate) when no valid ids', () => {
    addFloor(0, '', 'g')
    expect(deleteChatMessages('p', 'c', [])).toBe(false)
    expect(chatService.truncateFloors).not.toHaveBeenCalled()
  })
})

describe('saveChat', () => {
  it('maps assistant messages to floors (content + swipes + swipe_id), leaves user', () => {
    addFloor(0, '', 'g')
    addFloor(1, 'u', 'old')
    const chat = [
      { is_user: false, mes: 'newGreeting', swipes: ['newGreeting', 'alt'], swipe_id: 1 },
      { is_user: true, mes: 'u' },
      { is_user: false, mes: 'newResp' }
    ]
    expect(saveChat('p', 'c', chat)).toEqual({ ok: true, changedFrom: 0 })
    const floors = floorService.getAllFloors('p', 'c')
    expect(floors[0].response.content).toBe('newGreeting')
    expect(floors[0].swipes).toEqual(['newGreeting', 'alt'])
    expect(floors[0].swipe_id).toBe(1)
    expect(floors[1].response.content).toBe('newResp')
    expect(floors[1].user_message.content).toBe('u') // user untouched
  })

  it('returns ok:false on a non-array chat', () => {
    expect(saveChat('p', 'c', null)).toEqual({ ok: false, changedFrom: null })
  })

  it('a no-op echo performs ZERO floor writes and reports changedFrom null (audit P1-4)', () => {
    // Cards routinely write the whole SillyTavern.chat back unchanged — that must not rewrite
    // the transcript (or trigger the caller's re-fold).
    addFloor(0, '', 'g', ['g'])
    addFloor(1, 'u', 'hello', ['hello'])
    const chat = [
      { is_user: false, mes: 'g', swipes: ['g'], swipe_id: 0 },
      { is_user: true, mes: 'u' },
      { is_user: false, mes: 'hello', swipes: ['hello'], swipe_id: 0 }
    ]
    expect(saveChat('p', 'c', chat)).toEqual({ ok: true, changedFrom: null })
    expect(replayed()).toBe(false)
  })

  it('writes only the changed floors and reports the EARLIEST changed floor', () => {
    addFloor(0, '', 'g')
    addFloor(1, 'u', 'old')
    addFloor(2, 'u2', 'keep')
    const chat = [
      { is_user: false, mes: 'g' }, // unchanged
      { is_user: false, mes: 'EDITED' }, // floor 1 changed
      { is_user: false, mes: 'keep' } // unchanged
    ]
    expect(saveChat('p', 'c', chat)).toEqual({ ok: true, changedFrom: 1 })
    expect(stored()).toEqual([
      { floor: 0, user_content: '', response_content: 'g' },
      { floor: 1, user_content: 'u', response_content: 'EDITED' },
      { floor: 2, user_content: 'u2', response_content: 'keep' }
    ])
    expect(replayed()).toBe(false) // the republish started at floor 1, not 0
  })

  it('a swipe_id-only change still counts as a change', () => {
    addFloor(0, '', 'g', ['g', 'alt'])
    expect(
      saveChat('p', 'c', [{ is_user: false, mes: 'g', swipes: ['g', 'alt'], swipe_id: 1 }])
    ).toEqual({ ok: true, changedFrom: 0 })
    expect(floorService.getAllFloors('p', 'c')[0].swipe_id).toBe(1)
  })

  it('does NOT propagate the opening greeting onto a later floor (stale chat guard)', () => {
    // Owner bug: after a custom-start, a stale SillyTavern.chat held the home placeholder in the
    // assistant[1] slot; saving it clobbered floor 1's real response. floor 0 = 'HOME'.
    addFloor(0, '', 'HOME')
    addFloor(1, '', 'realReply')
    saveChat('p', 'c', [
      { is_user: false, mes: 'HOME' }, // floor 0 (greeting) — unchanged
      { is_user: false, mes: 'HOME' } // floor 1 — MUST NOT overwrite the real reply
    ])
    expect(stored()[1].response_content).toBe('realReply')
    expect(replayed()).toBe(false)
  })
})

describe('afterChatMutation', () => {
  it('returns the latest floor so the caller can push its variables', () => {
    addFloor(0, '', 'g')
    addFloor(1, 'a', 'b')
    expect(afterChatMutation('p', 'c')?.floor).toBe(1)
  })

  it('returns null when there are no floors', () => {
    expect(afterChatMutation('p', 'c')).toBe(null)
  })

  it('surfaces the re-fold the mutation itself already published', () => {
    // The `<UpdateVariable>` fold no longer happens HERE — `setChatMessages` writes through
    // FloorState, which republishes the changed suffix atomically. afterChatMutation just reads back.
    addFloor(0, '', 'greeting')
    addFloor(1, 'hi', 'old reply')
    expect(
      setChatMessages('p', 'c', [
        { message_id: 2, message: "<UpdateVariable>\n_.set('hp', 0, 42);\n</UpdateVariable>" }
      ])
    ).toBe(1)
    const latest = afterChatMutation('p', 'c', 1)
    expect(latest?.floor).toBe(1)
    expect((latest?.variables as any).stat_data).toEqual({ hp: 42 })
  })
})
