import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

import Adapter from '../mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'

let db: InstanceType<typeof Adapter>

vi.mock('../../src/main/services/sessionDbService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/services/sessionDbService')>()),
  getSessionDbByChat: () => db
}))
vi.mock('../../src/main/services/db', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }) })
  })
}))

import { deleteFloorAndSubsequent } from '../../src/main/services/floorService'

const count = (table: string): number =>
  (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number
    }
  ).count

describe('floor deletion transaction', () => {
  beforeEach(() => {
    db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
    db.prepare(
      `INSERT INTO floors
       (chat_id, floor, timestamp, user_content, response_content, events, variables)
       VALUES ('chat', 12, 'now', '', '', '[]', '{}')`
    ).run()
    db.prepare(
      `INSERT INTO floor_operations
       (chat_id, floor, seq, source, kind, path, value, created_at)
       VALUES ('chat', 12, 0, 'user', 'set', 'variables.flag', 'true', 'now')`
    ).run()
    db.prepare(
      `INSERT INTO vars_ops (chat_id, floor, seq, kind, payload, created_at)
       VALUES ('chat', 12, 0, 'replace', '{}', 'now')`
    ).run()
    db.prepare(
      `INSERT INTO floor_state_baselines (chat_id, variables, created_at)
       VALUES ('chat', '{}', 'now')`
    ).run()
    db.prepare(
      `INSERT INTO agent_runs
       (invocation_id, chat_id, floor, status, started_at, record)
       VALUES ('run', 'chat', 12, 'succeeded', 'now', '{}')`
    ).run()
  })

  it('rolls Run Record evidence and all floor-owned state back together', () => {
    db.exec(`
      CREATE TRIGGER reject_floor_delete
      BEFORE DELETE ON floors
      BEGIN
        SELECT RAISE(ABORT, 'floor deletion rejected');
      END;
    `)

    expect(() => deleteFloorAndSubsequent('profile', 'chat', 0)).toThrow(
      'floor deletion rejected'
    )
    expect({
      runs: count('agent_runs'),
      operations: count('floor_operations'),
      legacyOperations: count('vars_ops'),
      floors: count('floors'),
      baselines: count('floor_state_baselines')
    }).toEqual({
      runs: 1,
      operations: 1,
      legacyOperations: 1,
      floors: 1,
      baselines: 1
    })
  })
})
