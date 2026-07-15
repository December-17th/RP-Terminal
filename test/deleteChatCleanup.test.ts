import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

/**
 * Orphan-free deletion (performance-audit P1-8). Unlike the pure-helper suites this MUST observe
 * real SQLite so FK cascade actually fires and the non-cascading chat-keyed tables are observable:
 * swap the no-op better-sqlite3 alias for the real `node:sqlite`-backed adapter (foreign_keys is ON
 * by default there), and pin the app data dir to an isolated temp dir so the real db.ts SCHEMA runs
 * against a throwaway file DB and the per-chat sandbox/notes files land where the services expect.
 */
const DATA_DIR = path.join(os.tmpdir(), `rpt-del-cleanup-${randomUUID()}`)

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => DATA_DIR }
})

import { getDb } from '../src/main/services/db'
import { deleteChat } from '../src/main/services/chatService'
import { deleteCharacter } from '../src/main/services/characterService'
import { wipeProfile } from '../src/main/services/profileService'
import { sandboxDbPath, refillShadowPath } from '../src/main/services/tableDbService'
import { notesFilePath } from '../src/main/services/notesMemoryService'

afterAll(() => {
  // Close the open node:sqlite handle before removing the file (Windows locks it open otherwise).
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

// Every chat-keyed table with a `chat_id` column. The first block cascades off the chats FK; the
// second block carries NO foreign key and is deleted explicitly by the centralized teardown.
const CASCADING = [
  'floors',
  'combat_encounters',
  'node_state',
  'table_ops',
  'vars_ops',
  'table_progress',
  'table_refill_progress'
]
const NON_CASCADING = [
  'workflow_run_history',
  'workflow_trigger_state',
  'agent_pack_trigger_state'
]
const ALL_CHAT_KEYED = [...CASCADING, ...NON_CASCADING]

const countFor = (table: string, chatId: string): number =>
  (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE chat_id = ?`).get(chatId) as { c: number })
    .c

const chatFiles = (profileId: string, chatId: string): string[] => [
  sandboxDbPath(profileId, chatId),
  refillShadowPath(profileId, chatId),
  notesFilePath(profileId, chatId)
]

const ensureProfile = (profileId: string): void => {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)'
    )
    .run(profileId, 'P', now, now)
}

const ensureCharacter = (profileId: string, characterId: string): void => {
  getDb()
    .prepare('INSERT OR IGNORE INTO characters (id, profile_id, card, created_at) VALUES (?, ?, ?, ?)')
    .run(characterId, profileId, '{}', new Date().toISOString())
}

/** Seed a chat plus one row in EVERY chat-keyed table + the three per-chat files. */
const seedChat = (profileId: string, characterId: string, chatId: string): void => {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, profileId, characterId, now, now)
  db.prepare(
    'INSERT INTO floors (chat_id, floor, timestamp, user_content, response_content) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, 0, now, 'u', 'r')
  db.prepare('INSERT INTO combat_encounters (chat_id, data) VALUES (?, ?)').run(chatId, '{}')
  db.prepare('INSERT INTO node_state (chat_id, workflow_id, node_id, data) VALUES (?, ?, ?, ?)').run(
    chatId,
    'wf',
    'n',
    '{}'
  )
  db.prepare('INSERT INTO table_ops (chat_id, floor, seq, sql) VALUES (?, ?, ?, ?)').run(
    chatId,
    0,
    0,
    'noop'
  )
  db.prepare('INSERT INTO vars_ops (chat_id, floor, seq, kind, payload) VALUES (?, ?, ?, ?, ?)').run(
    chatId,
    0,
    0,
    'replace',
    '{}'
  )
  db.prepare('INSERT INTO table_progress (chat_id, sql_name, last_floor) VALUES (?, ?, ?)').run(
    chatId,
    't',
    0
  )
  db.prepare(
    'INSERT INTO table_refill_progress (chat_id, selected_json, from_floor, completed_until, status) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, '[]', 0, -1, 'in_progress')
  db.prepare(
    'INSERT INTO workflow_run_history (chat_id, seq, run_id, started_at, origin, pack_ids, ok, aborted, duration_ms, trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(chatId, 0, 'run', 0, 'turn', '[]', 1, 0, 0, '{}')
  db.prepare('INSERT INTO workflow_trigger_state (chat_id, doc_id, node_id) VALUES (?, ?, ?)').run(
    chatId,
    'd',
    'n'
  )
  db.prepare(
    'INSERT INTO agent_pack_trigger_state (chat_id, pack_id, trigger_index) VALUES (?, ?, ?)'
  ).run(chatId, 'pk', 0)
  // A per-chat EXCEPTION activation (chat_id set) — must be removed on chat deletion.
  db.prepare(
    'INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open) VALUES (?, ?, ?, ?)'
  ).run('pk', characterId, chatId, 1)

  for (const f of chatFiles(profileId, chatId)) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, 'x')
  }
}

const seededEverywhere = (chatId: string): void => {
  for (const t of ALL_CHAT_KEYED) expect(countFor(t, chatId), `seed ${t}`).toBe(1)
}
const expectAllGone = (profileId: string, chatId: string): void => {
  for (const t of ALL_CHAT_KEYED) expect(countFor(t, chatId), `orphan in ${t}`).toBe(0)
  expect(
    (
      getDb()
        .prepare('SELECT COUNT(*) AS c FROM agent_pack_activation WHERE chat_id = ?')
        .get(chatId) as { c: number }
    ).c,
    'orphan chat-scoped activation'
  ).toBe(0)
  for (const f of chatFiles(profileId, chatId)) expect(fs.existsSync(f), `orphan file ${f}`).toBe(false)
}

describe('deleteChat — centralized orphan-free teardown', () => {
  it('removes FK-cascade rows AND the non-cascading chat-keyed rows + per-chat files', () => {
    const profileId = `p-${randomUUID()}`
    const characterId = `c-${randomUUID()}`
    const chatId = `chat-${randomUUID()}`
    ensureProfile(profileId)
    // A WORLD-scope activation (chat_id NULL) for the same pack/world must SURVIVE the chat delete.
    getDb()
      .prepare(
        'INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open) VALUES (?, ?, ?, ?)'
      )
      .run('pk', characterId, null, 1)
    seedChat(profileId, characterId, chatId)
    seededEverywhere(chatId)

    deleteChat(profileId, chatId)

    expectAllGone(profileId, chatId)
    // The world-scope activation (chat_id NULL) is untouched.
    expect(
      (
        getDb()
          .prepare(
            'SELECT COUNT(*) AS c FROM agent_pack_activation WHERE world_id = ? AND chat_id IS NULL'
          )
          .get(characterId) as { c: number }
      ).c
    ).toBe(1)
  })
})

describe('deleteCharacter — cascades every chat through the centralized teardown', () => {
  it('leaves zero orphaned rows in every chat-keyed table and removes per-chat files', () => {
    const profileId = `p-${randomUUID()}`
    const characterId = `c-${randomUUID()}`
    ensureProfile(profileId)
    ensureCharacter(profileId, characterId)
    const chatA = `chat-${randomUUID()}`
    const chatB = `chat-${randomUUID()}`
    seedChat(profileId, characterId, chatA)
    seedChat(profileId, characterId, chatB)

    deleteCharacter(profileId, characterId)

    expect(
      (
        getDb().prepare('SELECT COUNT(*) AS c FROM characters WHERE id = ?').get(characterId) as {
          c: number
        }
      ).c
    ).toBe(0)
    for (const chatId of [chatA, chatB]) expectAllGone(profileId, chatId)
  })
})

describe('wipeProfile — resets every chat through the centralized teardown', () => {
  it('leaves zero orphaned rows in every chat-keyed table and removes per-chat files', () => {
    const profileId = `p-${randomUUID()}`
    const characterId = `c-${randomUUID()}`
    ensureProfile(profileId)
    ensureCharacter(profileId, characterId)
    const chatId = `chat-${randomUUID()}`
    seedChat(profileId, characterId, chatId)

    wipeProfile(profileId)

    expect(
      (
        getDb().prepare('SELECT COUNT(*) AS c FROM chats WHERE profile_id = ?').get(profileId) as {
          c: number
        }
      ).c
    ).toBe(0)
    expectAllGone(profileId, chatId)
  })
})
