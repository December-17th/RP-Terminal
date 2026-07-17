// test/yuzu/vnMode.test.ts
//
// Project Yuzu WP-S1 — the VN-mode flag round-trips through the additive `vn_mode` column: set → read via
// the isYuzuMode predicate. Also asserts it defaults off (NULL) and is orthogonal to the FSM `mode` column.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))
vi.mock('../../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import { closeDb, getDb } from '../../src/main/services/db'
import {
  isYuzuMode,
  setVnMode,
  getChatMode,
  setChatMode
} from '../../src/main/services/chatService'
import { closeAll } from '../../src/main/services/sessionDbService'

const P = 'pVn'
const C = 'cVn'

/** Insert a minimal profile + chat row directly (isYuzuMode/setVnMode only touch the `chats` row). */
const seedChat = (): void => {
  getDb()
    .prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(P, 'Vn', 't', 't')
  getDb()
    .prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(C, P, 'ch', 't', 't')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-yuzu-vnmode-'))
  seedChat()
})

afterEach(() => {
  closeAll()
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('VN-mode flag (vn_mode column)', () => {
  it('defaults off for a fresh chat (NULL)', () => {
    expect(isYuzuMode(P, C)).toBe(false)
  })

  it('round-trips set → read', () => {
    setVnMode(P, C, true)
    expect(isYuzuMode(P, C)).toBe(true)
    setVnMode(P, C, false)
    expect(isYuzuMode(P, C)).toBe(false)
  })

  it('is orthogonal to the FSM mode column', () => {
    setVnMode(P, C, true)
    setChatMode(P, C, 'combat')
    // Setting the FSM mode does not clear VN mode, and VN mode does not perturb the FSM mode.
    expect(isYuzuMode(P, C)).toBe(true)
    expect(getChatMode(P, C)).toBe('combat')
  })
})
