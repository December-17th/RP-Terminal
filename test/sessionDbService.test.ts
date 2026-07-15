import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  sessionDir,
  sessionDbPath,
  sessionKey,
  keysToEvict,
  SESSION_SCHEMA
} from '../src/main/services/sessionDbService'
import { getAppDir } from '../src/main/services/storageService'

// Only the PURE helpers are tested — better-sqlite3 is stubbed to a no-op under vitest, so the handle
// wrappers (getSessionDb/removeSession/closeAll) are runtime-validated only, mirroring tableDbService.

describe('session store paths', () => {
  it('sessionDir lives under the profile in its own chats/<chatId> folder, not the app DB', () => {
    const dir = sessionDir('prof1', 'chatA')
    expect(dir).toBe(path.join(getAppDir(), 'profiles', 'prof1', 'chats', 'chatA'))
    expect(dir).not.toContain('rpterminal.db')
  })

  it('sessionDbPath is session.sqlite inside the chat folder', () => {
    expect(sessionDbPath('prof1', 'chatA')).toBe(
      path.join(sessionDir('prof1', 'chatA'), 'session.sqlite')
    )
  })

  it('sessionKey is stable and distinguishes profile+chat', () => {
    expect(sessionKey('p', 'c')).toBe(sessionKey('p', 'c'))
    expect(sessionKey('p', 'c')).not.toBe(sessionKey('p', 'c2'))
    expect(sessionKey('p', 'c')).not.toBe(sessionKey('p2', 'c'))
  })
})

describe('keysToEvict (LRU policy)', () => {
  it('evicts nothing at or under the cap', () => {
    expect(keysToEvict([], 16)).toEqual([])
    expect(keysToEvict(['a', 'b'], 2)).toEqual([])
  })

  it('evicts the least-recent (front of the insertion-ordered list) first', () => {
    expect(keysToEvict(['a', 'b', 'c'], 2)).toEqual(['a'])
    expect(keysToEvict(['a', 'b', 'c', 'd', 'e'], 2)).toEqual(['a', 'b', 'c'])
  })
})

describe('SESSION_SCHEMA', () => {
  it('carries every chat-scoped table lifted from db.ts', () => {
    for (const t of [
      'floors',
      'combat_encounters',
      'node_state',
      'table_ops',
      'vars_ops',
      'table_progress',
      'table_refill_progress',
      'workflow_trigger_state'
    ]) {
      expect(SESSION_SCHEMA).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`)
    }
  })

  it('has NO foreign-key REFERENCES (a session DB has no chats table — plan review C5)', () => {
    expect(SESSION_SCHEMA).not.toMatch(/REFERENCES/i)
  })

  it('folds the addColumnIfMissing columns inline (fresh DB needs no forward migrations)', () => {
    // floors accreted columns
    for (const c of ['swipes', 'swipe_id', 'request', 'metrics', 'plot_block']) {
      expect(SESSION_SCHEMA).toContain(c)
    }
    // table_ops accreted columns
    for (const c of ['target_table', 'source', 'from_floor']) {
      expect(SESSION_SCHEMA).toContain(c)
    }
  })

  it('retains the chat_id column on every table (S1 stays a mechanical handle swap)', () => {
    expect(SESSION_SCHEMA.match(/chat_id/g)?.length ?? 0).toBeGreaterThanOrEqual(8)
  })
})
