import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

/**
 * Session-list cost (performance-audit P2-6, post-merge with the decentralized save system):
 * getChats used to run one latest-floor query PER chat (N+1). Floors now live in per-session
 * stores, and the listing reads a denormalized summary maintained by floorService.saveFloor
 * (refreshChatSummary) off the CENTRAL index — one statement, zero session DBs opened. This suite
 * runs the REAL stack (node:sqlite adapter) end-to-end: write floors through saveFloor, then pin
 * (a) ordering + summary content incl. preview stripping/clamping, (b) empty-chat shape,
 * (c) getChat/list parity + the §B3 self-heal, and (d) the one-statement listing.
 */
const DATA_DIR = path.join(os.tmpdir(), `rpt-session-list-${randomUUID()}`)

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => DATA_DIR }
})

import { getDb } from '../src/main/services/db'
import * as sessionDbService from '../src/main/services/sessionDbService'
import { getChats, getChat } from '../src/main/services/chatService'
import { saveFloor } from '../src/main/services/floorService'
import { FloorFile } from '../src/main/types/chat'

afterAll(() => {
  try {
    sessionDbService.closeAll()
  } catch {
    /* ignore */
  }
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

const writeFloor = (
  chatId: string,
  floor: number,
  timestamp: string,
  userContent: string,
  responseContent: string
): void =>
  saveFloor('p', chatId, {
    floor,
    chat_id: chatId,
    timestamp,
    user_message: { content: userContent, timestamp },
    response: { content: responseContent, model: 'm', provider: 'p' },
    events: [],
    variables: {}
  } as unknown as FloorFile)

describe('getChats — denormalized session listing (perf-audit P2-6 / save-plan §B3)', () => {
  const profileId = `p-${randomUUID()}`
  const chatA = `chat-a-${randomUUID()}` // 2 floors; newest updated_at
  const chatB = `chat-b-${randomUUID()}` // 1 floor
  const chatEmpty = `chat-empty-${randomUUID()}` // no floors

  ensureProfile(profileId)
  // chatA is most-recently updated; chatEmpty next; chatB oldest — proves ORDER BY updated_at DESC.
  insertChat(profileId, chatA, '2026-07-15T03:00:00.000Z')
  insertChat(profileId, chatEmpty, '2026-07-15T02:00:00.000Z')
  insertChat(profileId, chatB, '2026-07-15T01:00:00.000Z')

  // chatA floor 0 (older) then floor 1 (latest) — the summary must track the LATEST write. The
  // latest response carries a <think> block + an <UpdateVariable> block + HTML, all of which the
  // stored preview must drop (cleanForHistory + tag-strip in refreshChatSummary).
  const longUser = 'u'.repeat(400)
  writeFloor(chatA, 0, '2026-07-15T02:59:00.000Z', 'old user', 'old response')
  writeFloor(
    chatA,
    1,
    '2026-07-15T03:00:00.000Z',
    longUser,
    '<think>secret reasoning</think><p>Hello <b>world</b></p><UpdateVariable>x=1</UpdateVariable>'
  )
  writeFloor(chatB, 0, '2026-07-15T01:00:00.000Z', 'hi', 'plain reply')

  it('orders by updated_at DESC and serves the maintained latest-floor summary', () => {
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

  it('getChat self-heals a null (legacy/pre-migration) summary from the session store (§B3)', () => {
    getDb()
      .prepare(
        `UPDATE chats SET floor_count = NULL, last_floor = NULL, last_floor_ts = NULL,
           last_user_preview = NULL, last_response_preview = NULL WHERE id = ?`
      )
      .run(chatB)
    const healed = getChat(profileId, chatB)!
    expect(healed.floor_count).toBe(1)
    expect(healed.floor_index[0].response_preview).toBe('plain reply')
  })

  it('lists N chats with ONE central statement and NO session DB opened', () => {
    const spy = vi.spyOn(getDb(), 'prepare')
    try {
      getChats(profileId)
      // Old code prepared 1 chats query + N latest-floor queries. The denormalized listing
      // prepares exactly one statement total — and it never touches a floors table.
      expect(spy.mock.calls).toHaveLength(1)
      expect(spy.mock.calls[0][0]).not.toMatch(/floors/i)
    } finally {
      spy.mockRestore()
    }
  })
})
