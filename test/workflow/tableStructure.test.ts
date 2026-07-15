import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * Structural template edit + bound-chat migration (Memory-Manager WP4a). Unlike the pure-helper
 * suites, this MUST observe real SQLite: a migration derives canonical DDL from `sqlite_master` and
 * the rebuild-consistency AC needs the sandbox rows to be observable. The production native
 * better-sqlite3 can't load under plain Node, so we swap the no-op alias mock for a REAL
 * `node:sqlite`-backed adapter (`test/mocks/betterSqlite3Node.ts`) — for BOTH the per-chat sandbox
 * files and the in-memory app-DB op log — and mock only chatService's bound-chat lookup.
 */

// Real SQLite for the sandbox files (overrides the vitest better-sqlite3 alias for this suite).
vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

const hoisted = vi.hoisted(() => ({ boundChats: [] as string[], appDb: undefined as any }))

// A real in-memory app DB (the `table_ops` op log) built from the same adapter, shared as BOTH the
// central app DB and — since the op-log now lives in the per-chat SESSION db (§B2) — the session handle.
vi.mock('../../src/main/services/db', async () => {
  const { default: Adapter } = await import('../mocks/betterSqlite3Node')
  const appDb = new Adapter(':memory:')
  appDb.exec(
    'CREATE TABLE table_ops (chat_id TEXT NOT NULL, floor INTEGER NOT NULL, seq INTEGER NOT NULL, sql TEXT NOT NULL, created_at TEXT, target_table TEXT, source TEXT, from_floor INTEGER, PRIMARY KEY (chat_id, floor, seq))'
  )
  hoisted.appDb = appDb
  return { getDb: () => appDb }
})

// tableOpsService/tableStructureService resolve the op-log through getSessionDbByChat now — point it at
// the same in-memory app DB (which carries the table_ops table + supports nested transactions).
vi.mock('../../src/main/services/sessionDbService', () => ({
  getSessionDbByChat: () => hoisted.appDb
}))

// The bound-chat enumeration (the only chatService export tableStructureService imports).
vi.mock('../../src/main/services/chatService', () => ({
  listChatIdsForTableTemplate: () => hoisted.boundChats
}))

import { TableTemplateSchema, type TableTemplate } from '../../src/main/types/tableTemplate'
import {
  applyStructureOps,
  planStructureOps,
  type StructureOp
} from '../../src/main/services/tableStructureService'
import {
  getTableTemplateById,
  saveTableTemplate
} from '../../src/main/services/tableTemplateService'
import { instantiate, readAllTables, sandboxDbPath } from '../../src/main/services/tableDbService'
import { applySqlBatch } from '../../src/main/services/tableSql'
import {
  rebuildSandbox,
  appendOps,
  listOps,
  beginTableWrite,
  endTableWrite
} from '../../src/main/services/tableOpsService'
import { getDb } from '../../src/main/services/db'
import RealDatabase from '../mocks/betterSqlite3Node'

const P = 'wp4aProfile'
const T = 'tpl-1'
const profileDir = path.join(os.tmpdir(), 'rpt-vitest-data', 'profiles', P)

const baseTemplate = (): TableTemplate =>
  TableTemplateSchema.parse({
    name: 'World Memory',
    tables: [
      {
        uid: 'uid-chronicle',
        displayName: '纪要表',
        sqlName: 'chronicle',
        ddl: 'CREATE TABLE chronicle (row_id INTEGER PRIMARY KEY, summary TEXT, location TEXT)',
        headers: ['row_id', '概要', '地点'],
        initialRows: [['', '序章', '起点']],
        note: 'Track the summary and location columns.',
        insertNode: 'INSERT INTO chronicle ...',
        updateFrequency: 2,
        exportConfig: {
          enabled: true,
          entryType: 'keyword',
          keywords: 'summary,location',
          extraIndexColumns: ['location'],
          extraIndexColumnModes: { location: 'both' }
        }
      },
      {
        uid: 'uid-characters',
        displayName: '角色表',
        sqlName: 'characters',
        ddl: 'CREATE TABLE characters (row_id INTEGER PRIMARY KEY, name TEXT)',
        headers: ['row_id', '名称'],
        initialRows: []
      }
    ]
  })

/** Seed the template file + a bound chat's sandbox with two chronicle rows (the seed row + one AI row). */
const seedChatWithRows = (chatId: string, tpl: TableTemplate, secondSummary = '第一章'): void => {
  instantiate(P, chatId, tpl) // seeds initialRows → chronicle row_id=1 (序章/起点)
  applySqlBatch(
    P,
    chatId,
    tpl,
    `INSERT INTO chronicle (summary, location) VALUES ('${secondSummary}', '城')`
  ) // → chronicle row_id=2
}

const chronicleOf = (chatId: string, tpl: TableTemplate) =>
  readAllTables(P, chatId, tpl).find((t) => t.sqlName === 'chronicle')!

beforeEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
  getDb().exec('DELETE FROM table_ops')
  hoisted.boundChats = []
  saveTableTemplate(P, baseTemplate(), T)
})

afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('tableStructureService — structural edit + migration', () => {
  it('addColumn: existing rows preserved, the new column present + empty', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())

    const res = applyStructureOps(P, T, [
      { kind: 'addColumn', uid: 'uid-chronicle', name: 'mood', type: 'TEXT' }
    ])
    expect(res).toMatchObject({ ok: true, columnsChanged: 1, chatsMigrated: 1 })

    const tpl = getTableTemplateById(P, T)!
    const chron = tpl.tables.find((t) => t.sqlName === 'chronicle')!
    expect(chron.ddl).toContain('mood')
    expect(chron.headers).toEqual(['row_id', '概要', '地点', 'mood'])

    const read = chronicleOf('chatA', tpl)
    expect(read.rows.map((r) => r[1])).toEqual(['序章', '第一章']) // summaries preserved
    expect(read.rows.map((r) => r[3])).toEqual([null, null]) // new column empty
  })

  it('renameColumn: data preserved under the new name; headers + exportConfig remapped', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())

    const res = applyStructureOps(P, T, [
      { kind: 'renameColumn', uid: 'uid-chronicle', from: 'location', to: 'place' }
    ])
    expect(res.ok).toBe(true)

    const tpl = getTableTemplateById(P, T)!
    const chron = tpl.tables.find((t) => t.sqlName === 'chronicle')!
    expect(chron.ddl).toContain('place')
    expect(chron.ddl).not.toMatch(/\blocation\b/)
    expect(chron.headers).toEqual(['row_id', '概要', '地点']) // 地点 label carried onto place
    expect(chron.exportConfig.keywords).toBe('summary,place')
    expect(chron.exportConfig.extraIndexColumns).toEqual(['place'])
    expect(chron.exportConfig.extraIndexColumnModes).toEqual({ place: 'both' })

    const read = chronicleOf('chatA', tpl)
    expect(read.rows.map((r) => r[2])).toEqual(['起点', '城']) // place values preserved
    // The note prose still says "location" → flagged, not rewritten.
    expect((res as { warnings: string[] }).warnings.some((w) => w.includes('location'))).toBe(true)
  })

  it('dropColumn: the column is gone, the others intact', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())

    const res = applyStructureOps(P, T, [
      { kind: 'dropColumn', uid: 'uid-chronicle', name: 'location' }
    ])
    expect(res.ok).toBe(true)

    const tpl = getTableTemplateById(P, T)!
    const chron = tpl.tables.find((t) => t.sqlName === 'chronicle')!
    expect(chron.headers).toEqual(['row_id', '概要'])
    expect(chron.ddl).not.toMatch(/\blocation\b/)
    expect(chron.exportConfig.keywords).toBe('summary')
    expect(chron.exportConfig.extraIndexColumns).toEqual([])
    expect(chron.exportConfig.extraIndexColumnModes).toEqual({})

    const read = chronicleOf('chatA', tpl)
    expect(read.rows).toEqual([
      [1, '序章'],
      [2, '第一章']
    ])
    // The seed row's location value was dropped → a warning.
    expect((res as { warnings: string[] }).warnings.some((w) => w.includes('initialRows'))).toBe(
      true
    )
  })

  it('addTable: a new empty table appears in the template + sandbox', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())

    const res = applyStructureOps(P, T, [
      {
        kind: 'addTable',
        sqlName: 'quests',
        displayName: '任务',
        columns: [{ name: 'row_id', type: 'INTEGER PRIMARY KEY' }, { name: 'title' }]
      }
    ])
    expect(res).toMatchObject({ ok: true, tablesChanged: 1 })

    const tpl = getTableTemplateById(P, T)!
    const quests = tpl.tables.find((t) => t.sqlName === 'quests')
    expect(quests).toBeTruthy()
    expect(quests!.displayName).toBe('任务')
    expect(quests!.headers).toEqual(['row_id', 'title'])

    const read = readAllTables(P, 'chatA', tpl).find((t) => t.sqlName === 'quests')!
    expect(read.rows).toEqual([])
  })

  it('dropTable: the table is removed from the template', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())

    const res = applyStructureOps(P, T, [{ kind: 'dropTable', uid: 'uid-characters' }])
    expect(res).toMatchObject({ ok: true, tablesChanged: 1 })

    const tpl = getTableTemplateById(P, T)!
    expect(tpl.tables.map((t) => t.sqlName)).toEqual(['chronicle'])
  })

  it('renameTable: sqlName + displayName change, rows still readable', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())

    const res = applyStructureOps(P, T, [
      { kind: 'renameTable', uid: 'uid-characters', sqlName: 'people', displayName: '人物' }
    ])
    expect(res.ok).toBe(true)

    const tpl = getTableTemplateById(P, T)!
    const people = tpl.tables.find((t) => t.uid === 'uid-characters')!
    expect(people.sqlName).toBe('people')
    expect(people.displayName).toBe('人物')
    expect(people.ddl).toMatch(/\bpeople\b/)
    // Reading the renamed table succeeds (empty).
    expect(readAllTables(P, 'chatA', tpl).find((t) => t.sqlName === 'people')!.rows).toEqual([])
  })

  it('REBUILD-CONSISTENCY: after migration, a rebuild reproduces the migrated rows exactly', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())

    const res = applyStructureOps(P, T, [
      { kind: 'addColumn', uid: 'uid-chronicle', name: 'mood', type: 'TEXT' },
      { kind: 'renameColumn', uid: 'uid-chronicle', from: 'location', to: 'place' }
    ])
    expect(res.ok).toBe(true)

    const tpl = getTableTemplateById(P, T)!
    const migrated = readAllTables(P, 'chatA', tpl)

    // Rewind/rebuild: instantiate(new DDL + new initialRows) then replay the re-baselined op log.
    rebuildSandbox(P, 'chatA', tpl)
    const rebuilt = readAllTables(P, 'chatA', tpl)

    // The whole read (rows AND rowids) must be identical — proves the op-log re-baseline is lossless.
    expect(rebuilt).toEqual(migrated)
    const chron = rebuilt.find((t) => t.sqlName === 'chronicle')!
    expect(chron.rows.map((r) => r[2])).toEqual(['起点', '城']) // place preserved through the rebuild
    expect(chron.rowids).toEqual([1, 2])
  })

  it('multi-chat: two bound chats both migrate + each rebuilds losslessly', () => {
    hoisted.boundChats = ['chatA', 'chatB']
    seedChatWithRows('chatA', baseTemplate(), '甲章')
    seedChatWithRows('chatB', baseTemplate(), '乙章')

    const res = applyStructureOps(P, T, [{ kind: 'addColumn', uid: 'uid-chronicle', name: 'mood' }])
    expect(res).toMatchObject({ ok: true, chatsMigrated: 2 })

    const tpl = getTableTemplateById(P, T)!
    expect(chronicleOf('chatA', tpl).rows.map((r) => r[1])).toEqual(['序章', '甲章'])
    expect(chronicleOf('chatB', tpl).rows.map((r) => r[1])).toEqual(['序章', '乙章'])

    for (const chat of ['chatA', 'chatB']) {
      const migrated = readAllTables(P, chat, tpl)
      rebuildSandbox(P, chat, tpl)
      expect(readAllTables(P, chat, tpl)).toEqual(migrated)
    }
  })

  it('validation: an invalid op rejects the whole batch; template + sandbox unchanged', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())
    const templateBefore = getTableTemplateById(P, T)
    const rowsBefore = readAllTables(P, 'chatA', baseTemplate())

    // (a) duplicate column
    expect(
      applyStructureOps(P, T, [{ kind: 'addColumn', uid: 'uid-chronicle', name: 'summary' }])
    ).toEqual({ ok: false, error: 'tables.structureColumnExists' })
    // (b) unknown table
    expect(applyStructureOps(P, T, [{ kind: 'dropTable', uid: 'nope' }])).toEqual({
      ok: false,
      error: 'tables.structureUnknownTable'
    })
    // (c) bad identifier
    expect(
      applyStructureOps(P, T, [{ kind: 'addColumn', uid: 'uid-chronicle', name: '1bad' }])
    ).toEqual({ ok: false, error: 'tables.structureBadName' })

    // Nothing changed.
    expect(getTableTemplateById(P, T)).toEqual(templateBefore)
    expect(readAllTables(P, 'chatA', baseTemplate())).toEqual(rowsBefore)
  })

  it('no bound chats: template still migrates via a throwaway DB', () => {
    hoisted.boundChats = []
    const res = applyStructureOps(P, T, [{ kind: 'addColumn', uid: 'uid-chronicle', name: 'mood' }])
    expect(res).toMatchObject({ ok: true, columnsChanged: 1, chatsMigrated: 0 })
    expect(getTableTemplateById(P, T)!.tables[0].headers).toContain('mood')
  })

  it('a derivation failure (dropping the PK) leaves template + every bound sandbox byte-for-byte unchanged', () => {
    hoisted.boundChats = ['chatA']
    seedChatWithRows('chatA', baseTemplate())
    const templateBefore = getTableTemplateById(P, T)
    const sandboxBytesBefore = fs.readFileSync(sandboxDbPath(P, 'chatA'))
    appendOps(P, 'chatA', 5, ["INSERT INTO chronicle (summary) VALUES ('sentinel')"]) // must survive
    const opsBefore = listOps(P, 'chatA')

    // Passes op validation but SQLite rejects DROP of the PRIMARY KEY column during derivation.
    const res = applyStructureOps(P, T, [
      { kind: 'dropColumn', uid: 'uid-chronicle', name: 'row_id' }
    ])
    expect(res).toEqual({ ok: false, error: 'tables.structureDeriveFailed' })

    expect(getTableTemplateById(P, T)).toEqual(templateBefore) // template untouched
    expect(fs.readFileSync(sandboxDbPath(P, 'chatA')).equals(sandboxBytesBefore)).toBe(true) // sandbox untouched
    expect(listOps(P, 'chatA')).toEqual(opsBefore) // op-log untouched
  })

  it('a per-chat failure rolls back to the OLD schema + OLD op-log and is reported in failedChats', () => {
    hoisted.boundChats = ['chatA', 'chatB']
    seedChatWithRows('chatA', baseTemplate())
    seedChatWithRows('chatB', baseTemplate())
    // Index `location` on chatB only, so DROP COLUMN location fails there but succeeds on chatA.
    const idxDb = new RealDatabase(sandboxDbPath(P, 'chatB'))
    idxDb.exec('CREATE INDEX idx_loc ON chronicle(location)')
    idxDb.close()
    // A distinctive old op on chatB that must survive the failed migration.
    appendOps(P, 'chatB', 3, ["INSERT INTO chronicle (summary) VALUES ('B-sentinel')"])
    const chatBOpsBefore = listOps(P, 'chatB')

    const res = applyStructureOps(P, T, [
      { kind: 'dropColumn', uid: 'uid-chronicle', name: 'location' }
    ])
    expect(res.ok).toBe(true)
    const rep = res as {
      ok: true
      chatsMigrated: number
      failedChats: { chatId: string; reason: string }[]
    }
    expect(rep.chatsMigrated).toBe(1)
    expect(rep.failedChats.map((f) => f.chatId)).toEqual(['chatB'])
    expect(rep.failedChats[0].reason).toBeTruthy()

    // The template WAS saved (new 2-column schema).
    const tpl = getTableTemplateById(P, T)!
    expect(tpl.tables.find((t) => t.sqlName === 'chronicle')!.headers).toEqual(['row_id', '概要'])

    // chatA migrated (readable on the new template).
    expect(chronicleOf('chatA', tpl).rows).toEqual([
      [1, '序章'],
      [2, '第一章']
    ])

    // chatB is left on the OLD schema (location still present + data intact) with its OLD op-log.
    const chatBOld = readAllTables(P, 'chatB', baseTemplate()).find(
      (t) => t.sqlName === 'chronicle'
    )!
    expect(chatBOld.rows).toEqual([
      [1, '序章', '起点'],
      [2, '第一章', '城']
    ])
    expect(listOps(P, 'chatB')).toEqual(chatBOpsBefore)
  })

  it('BUSY-REJECT: a live write on ANY bound chat throws before mutating the template or any chat', () => {
    hoisted.boundChats = ['chatA', 'chatB']
    seedChatWithRows('chatA', baseTemplate())
    seedChatWithRows('chatB', baseTemplate())
    const templateBefore = getTableTemplateById(P, T)
    const chatABytesBefore = fs.readFileSync(sandboxDbPath(P, 'chatA'))
    const chatBBytesBefore = fs.readFileSync(sandboxDbPath(P, 'chatB'))
    const chatAOpsBefore = listOps(P, 'chatA')
    const chatBOpsBefore = listOps(P, 'chatB')

    // A long refill owns chatB's write guard (chatA is idle). The structure apply must refuse the WHOLE
    // batch up-front — nothing migrated, not even the idle chatA.
    const token = beginTableWrite('chatB')
    expect(token).not.toBeNull()
    try {
      expect(() =>
        applyStructureOps(P, T, [{ kind: 'addColumn', uid: 'uid-chronicle', name: 'mood' }])
      ).toThrow('tables.memoryWriteBusy')
    } finally {
      endTableWrite('chatB', token!)
    }

    // Template untouched (never re-saved), both sandboxes byte-for-byte identical, both op-logs intact.
    expect(getTableTemplateById(P, T)).toEqual(templateBefore)
    expect(fs.readFileSync(sandboxDbPath(P, 'chatA')).equals(chatABytesBefore)).toBe(true)
    expect(fs.readFileSync(sandboxDbPath(P, 'chatB')).equals(chatBBytesBefore)).toBe(true)
    expect(listOps(P, 'chatA')).toEqual(chatAOpsBefore)
    expect(listOps(P, 'chatB')).toEqual(chatBOpsBefore)
  })

  it('planStructureOps (pure) rejects a rename onto an existing column', () => {
    const plan = planStructureOps(baseTemplate(), [
      { kind: 'renameColumn', uid: 'uid-chronicle', from: 'summary', to: 'location' }
    ] as StructureOp[])
    expect(plan).toEqual({ ok: false, error: 'tables.structureColumnExists' })
  })
})
