import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Integration test for the one-time decentralization migration (plan §B5). Uses the REAL node:sqlite
 * adapter for BOTH the central app DB and the per-chat session files, and points the data root at a
 * temp dir, so the actual row-copy + file-split + marker flip are observable end to end.
 */

let tmp: string
vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import Database from './mocks/betterSqlite3Node'
import { getDb, closeDb } from '../src/main/services/db'
import { migrateSessionsIfNeeded } from '../src/main/services/sessionMigrationService'
import { closeAll } from '../src/main/services/sessionDbService'

const P = 'profM'
const CH = 'char1'
const C = 'chatMig'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-mig-'))
  const db = getDb() // creates rpterminal.db + full schema (incl. session_migrated + summary cols)
  db.prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run(
    P,
    'M',
    't',
    't'
  )
  db.prepare('INSERT INTO characters (id, profile_id, card, created_at) VALUES (?, ?, ?, ?)').run(
    CH,
    P,
    '{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"W"}}',
    't'
  )
  // A pre-existing chat still in the central tables (session_migrated defaults to 0).
  db.prepare(
    'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(C, P, CH, 't', 't')
  const ins = db.prepare(
    `INSERT INTO floors (chat_id, floor, timestamp, user_content, response_content)
     VALUES (?, ?, ?, ?, ?)`
  )
  ins.run(C, 0, 't', '', 'greeting')
  ins.run(C, 1, 't', 'hi there', 'the reply body')
  db.prepare(
    'INSERT INTO table_ops (chat_id, floor, seq, sql, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(C, 1, 0, 'INSERT INTO t VALUES (1)', 't')
  // Legacy per-chat files.
  fs.mkdirSync(path.join(tmp, 'profiles', P, 'chat-notes'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'profiles', P, 'chat-notes', `${C}.md`), '## note\nbody', 'utf-8')
  fs.writeFileSync(
    path.join(tmp, 'profiles', P, 'chat-card-vars.json'),
    JSON.stringify({ [C]: { party: ['a'] }, other: { x: 1 } }),
    'utf-8'
  )
})

afterEach(() => {
  closeAll() // release per-chat session handles
  closeDb() // release the memoized central DB so the temp dir can be removed + next test starts fresh
  fs.rmSync(tmp, { recursive: true, force: true })
})

const sessionDir = (): string => path.join(tmp, 'profiles', P, 'chats', C)

describe('migrateSessionsIfNeeded', () => {
  it('copies floors + table_ops into session.sqlite and flips the marker', () => {
    migrateSessionsIfNeeded()

    // Marker flipped.
    const row = getDb()
      .prepare('SELECT session_migrated, floor_count FROM chats WHERE id = ?')
      .get(C) as {
      session_migrated: number
      floor_count: number
    }
    expect(row.session_migrated).toBe(1)
    // B3 summary computed from the session store.
    expect(row.floor_count).toBe(2)

    // Session DB has the copied rows.
    const sdb = new Database(path.join(sessionDir(), 'session.sqlite'))
    try {
      const floors = sdb
        .prepare('SELECT floor, response_content FROM floors ORDER BY floor')
        .all() as Array<{
        floor: number
        response_content: string
      }>
      expect(floors.map((f) => f.floor)).toEqual([0, 1])
      expect(floors[1].response_content).toBe('the reply body')
      const ops = sdb.prepare('SELECT COUNT(*) AS n FROM table_ops').get() as { n: number }
      expect(ops.n).toBe(1)
    } finally {
      sdb.close()
    }
  })

  it('splits notes + this chat’s session-vars into the folder (legacy left intact)', () => {
    migrateSessionsIfNeeded()
    expect(fs.readFileSync(path.join(sessionDir(), 'notes.md'), 'utf-8')).toBe('## note\nbody')
    expect(
      JSON.parse(fs.readFileSync(path.join(sessionDir(), 'session-vars.json'), 'utf-8'))
    ).toEqual({
      party: ['a']
    })
    // COPY not MOVE (review C1): the legacy shared file survives as a safety net.
    expect(fs.existsSync(path.join(tmp, 'profiles', P, 'chat-card-vars.json'))).toBe(true)
  })

  it('is idempotent + resumable (a second run does nothing, no duplicate rows)', () => {
    migrateSessionsIfNeeded()
    migrateSessionsIfNeeded() // no pending chats now → no-op; must not duplicate
    const sdb = new Database(path.join(sessionDir(), 'session.sqlite'))
    try {
      const { n } = sdb.prepare('SELECT COUNT(*) AS n FROM floors').get() as { n: number }
      expect(n).toBe(2)
    } finally {
      sdb.close()
    }
  })

  it('backs up the central DB before migrating', () => {
    migrateSessionsIfNeeded()
    expect(fs.existsSync(path.join(tmp, 'rpterminal.db.pre-decentralize.bak'))).toBe(true)
  })
})
