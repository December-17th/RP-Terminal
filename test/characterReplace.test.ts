import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import { closeDb, getDb } from '../src/main/services/db'
import { getCharacter, replaceCharacterFromFile } from '../src/main/services/characterService'
import { closeAll, getSessionDb, sessionDir } from '../src/main/services/sessionDbService'

const P = 'replace-profile'
const OLD = 'old-world'
const CHAT = 'old-chat'

const card = (name: string): Record<string, unknown> => ({
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
    character_version: '2.0',
    extensions: {}
  }
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-replace-'))
  const db = getDb()
  db.prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run(
    P,
    'Replace',
    't',
    't'
  )
  db.prepare('INSERT INTO characters (id, profile_id, card, created_at) VALUES (?, ?, ?, ?)').run(
    OLD,
    P,
    JSON.stringify(card('Old World')),
    't'
  )
  db.prepare(
    'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at, session_migrated) VALUES (?, ?, ?, ?, ?, 1)'
  ).run(CHAT, P, OLD, 't', 't')
  getSessionDb(P, CHAT)
})

afterEach(() => {
  closeAll()
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('replaceCharacterFromFile', () => {
  it('keeps the installed world and its sessions when the replacement cannot be parsed', () => {
    const invalid = path.join(tmp, 'invalid.json')
    fs.writeFileSync(invalid, '{', 'utf-8')

    expect(replaceCharacterFromFile(P, OLD, invalid)).toBeNull()
    expect(getCharacter(P, OLD)?.data.name).toBe('Old World')
    expect(
      getDb().prepare('SELECT id FROM chats WHERE id = ?').get(CHAT) as { id: string } | undefined
    ).toEqual({ id: CHAT })
    expect(fs.existsSync(sessionDir(P, CHAT))).toBe(true)
  })

  it('deletes the old world only after a replacement has been installed', () => {
    const replacement = path.join(tmp, 'replacement.json')
    fs.writeFileSync(replacement, JSON.stringify(card('New World')), 'utf-8')

    const result = replaceCharacterFromFile(P, OLD, replacement)
    expect(result).not.toBeNull()
    expect(result?.id).not.toBe(OLD)
    expect(getCharacter(P, OLD)).toBeNull()
    expect(getCharacter(P, result!.id)?.data.name).toBe('New World')
    expect(getDb().prepare('SELECT id FROM chats WHERE id = ?').get(CHAT)).toBeUndefined()
    expect(fs.existsSync(sessionDir(P, CHAT))).toBe(false)
  })
})
