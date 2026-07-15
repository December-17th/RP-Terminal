import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Round-trip test for save export/import (plan §B6 / Feature 2). Real node:sqlite for the central DB
 * and per-chat session files; real AdmZip for the `.rpsave`. Exercises: build a save from a migrated
 * chat, import it into a NEW chat bound to the referenced (installed) world, remap chat_id, and the
 * "world not installed" rejection.
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
import { buildSaveZip, importSave } from '../src/main/services/saveTransferService'
import { closeAll } from '../src/main/services/sessionDbService'

const P = 'profS'
const CH = 'worldA'
const C = 'chatSrc'

const fullCard = (name: string): string =>
  JSON.stringify({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: 'Ada',
      character_version: '1.0',
      extensions: {}
    }
  })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-save-'))
  const db = getDb()
  db.prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run(
    P,
    'S',
    't',
    't'
  )
  db.prepare('INSERT INTO characters (id, profile_id, card, created_at) VALUES (?, ?, ?, ?)').run(
    CH,
    P,
    fullCard('Verdant'),
    't'
  )
  db.prepare(
    'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(C, P, CH, 't', 't')
  const ins = db.prepare(
    'INSERT INTO floors (chat_id, floor, timestamp, user_content, response_content) VALUES (?, ?, ?, ?, ?)'
  )
  ins.run(C, 0, 't', '', 'greeting')
  ins.run(C, 1, 't', 'hello', 'a saved reply')
  migrateSessionsIfNeeded() // decentralize C into chats/C/session.sqlite
})

afterEach(() => {
  closeAll()
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const exportToFile = (): string => {
  const built = buildSaveZip(P, C)
  if ('error' in built) throw new Error(`export failed: ${built.error}`)
  const file = path.join(tmp, 'out.rpsave')
  fs.writeFileSync(file, built.buffer)
  return file
}

describe('save export/import round-trip', () => {
  it('imports a save into a NEW chat bound to the installed world, floors intact + remapped', () => {
    const file = exportToFile()
    const res = importSave(P, file)
    if ('error' in res) throw new Error(`import failed: ${res.error}`)
    expect(res.chatId).not.toBe(C)

    // A new index row bound to the same world, with a computed summary.
    const row = getDb()
      .prepare('SELECT character_id, floor_count, session_migrated FROM chats WHERE id = ?')
      .get(res.chatId) as { character_id: string; floor_count: number; session_migrated: number }
    expect(row.character_id).toBe(CH)
    expect(row.floor_count).toBe(2)
    expect(row.session_migrated).toBe(1)

    // The imported session store has the floors, remapped to the NEW chat_id.
    const sdb = new Database(path.join(tmp, 'profiles', P, 'chats', res.chatId, 'session.sqlite'))
    try {
      const floors = sdb
        .prepare('SELECT chat_id, response_content FROM floors ORDER BY floor')
        .all() as Array<{ chat_id: string; response_content: string }>
      expect(floors.map((f) => f.response_content)).toEqual(['greeting', 'a saved reply'])
      expect(new Set(floors.map((f) => f.chat_id))).toEqual(new Set([res.chatId]))
    } finally {
      sdb.close()
    }
  })

  it('rejects import when the referenced world is not installed', () => {
    const file = exportToFile()
    // Remove the world so the save can no longer resolve it.
    getDb().prepare('DELETE FROM characters WHERE id = ?').run(CH)
    const res = importSave(P, file)
    expect('error' in res && res.error).toBe('save.worldMissing')
  })

  it('errors cleanly on a non-save archive', () => {
    const bogus = path.join(tmp, 'bogus.rpsave')
    fs.writeFileSync(bogus, 'not a zip')
    const res = importSave(P, bogus)
    expect('error' in res && res.error).toBe('save.badArchive')
  })
})
