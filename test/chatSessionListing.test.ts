import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

/**
 * Session-list folding (performance-audit P2-6): getChats used to run one latest-floor query PER
 * chat (N+1) on top of the chat listing. It now folds the latest floor into ONE joined query. This
 * suite pins that behavior: swap the no-op better-sqlite3 alias for the real `node:sqlite`-backed
 * adapter so the JOIN + correlated subqueries actually execute, seed several chats + an empty one,
 * and assert (a) the session shape is byte-identical to the old per-chat build, (b) an empty chat
 * yields floor_index [], and (c) listing N chats prepares exactly ONE floors-touching statement.
 */
const DATA_DIR = path.join(os.tmpdir(), `rpt-session-list-${randomUUID()}`)

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => DATA_DIR }
})

import { getDb } from '../src/main/services/db'
import { getChats, getChat } from '../src/main/services/chatService'

afterAll(() => {
  try {
    ;(getDb() as unknown as { close: () => void }).close()
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

const ensureProfile = (profileId: string): void => {
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT OR IGNORE INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(profileId, 'P', now, now)
}

const insertChat = (profileId: string, chatId: string, updatedAt: string): void => {
  getDb()
    .prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(chatId, profileId, 'char', updatedAt, updatedAt)
}

const insertFloor = (
  chatId: string,
  floor: number,
  timestamp: string,
  userContent: string,
  responseContent: string
): void => {
  getDb()
    .prepare(
      'INSERT INTO floors (chat_id, floor, timestamp, user_content, response_content) VALUES (?, ?, ?, ?, ?)'
    )
    .run(chatId, floor, timestamp, userContent, responseContent)
}

describe('getChats — single-query session listing (perf-audit P2-6)', () => {
  const profileId = `p-${randomUUID()}`
  const chatA = `chat-a-${randomUUID()}` // 2 floors; newest updated_at
  const chatB = `chat-b-${randomUUID()}` // 1 floor
  const chatEmpty = `chat-empty-${randomUUID()}` // no floors

  ensureProfile(profileId)
  // chatA is most-recently updated; chatEmpty next; chatB oldest — proves ORDER BY updated_at DESC.
  insertChat(profileId, chatA, '2026-07-15T03:00:00.000Z')
  insertChat(profileId, chatEmpty, '2026-07-15T02:00:00.000Z')
  insertChat(profileId, chatB, '2026-07-15T01:00:00.000Z')

  // chatA floor 0 (older) then floor 1 (latest) — latest must win. The latest response carries a
  // <think> block + an <UpdateVariable> block + HTML, all of which the preview must drop.
  const longUser = 'u'.repeat(400)
  insertFloor(chatA, 0, '2026-07-15T02:59:00.000Z', 'old user', 'old response')
  insertFloor(
    chatA,
    1,
    '2026-07-15T03:00:00.000Z',
    longUser,
    '<think>secret reasoning</think><p>Hello <b>world</b></p><UpdateVariable>x=1</UpdateVariable>'
  )
  insertFloor(chatB, 0, '2026-07-15T01:00:00.000Z', 'hi', 'plain reply')

  it('orders by updated_at DESC and folds the latest floor into each session', () => {
    const sessions = getChats(profileId)
    expect(sessions.map((s) => s.id)).toEqual([chatA, chatEmpty, chatB])

    const a = sessions[0]
    expect(a.floor_count).toBe(2)
    expect(a.floor_index).toHaveLength(1)
    expect(a.floor_index[0].floor).toBe(1) // latest floor, not floor 0
    expect(a.floor_index[0].timestamp).toBe('2026-07-15T03:00:00.000Z')
    // user preview: HTML-free + clamped to USER_PREVIEW_LEN (160)
    expect(a.floor_index[0].user_preview).toBe('u'.repeat(160))
    // response preview: <think> + <UpdateVariable> gone (cleanForHistory), remaining tags stripped
    expect(a.floor_index[0].response_preview).toBe('Hello world')
  })

  it('yields floor_index [] for a chat with no floors', () => {
    const sessions = getChats(profileId)
    const empty = sessions.find((s) => s.id === chatEmpty)!
    expect(empty.floor_count).toBe(0)
    expect(empty.floor_index).toEqual([])
  })

  it('getChat returns the same shape as the listing entry', () => {
    const single = getChat(profileId, chatA)
    const fromList = getChats(profileId).find((s) => s.id === chatA)
    expect(single).toEqual(fromList)
  })

  it('lists N chats with a SINGLE floors query (no N+1)', () => {
    const spy = vi.spyOn(getDb(), 'prepare')
    try {
      getChats(profileId)
      // Old code prepared 1 chats query + N latest-floor queries. The fold prepares exactly one
      // statement total for the whole listing, regardless of how many chats it returns.
      expect(spy.mock.calls).toHaveLength(1)
      expect(spy.mock.calls[0][0]).toMatch(/floors/)
    } finally {
      spy.mockRestore()
    }
  })
})
