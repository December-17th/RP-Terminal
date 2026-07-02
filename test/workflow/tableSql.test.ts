import { describe, it, expect } from 'vitest'
import {
  splitSqlStatements,
  classifyStatement,
  validateBatch,
  TableSqlError
} from '../../src/main/services/tableSql'

// Pure SQL splitter/classifier/validateBatch tests — the security-critical slice (issue 03). No real
// SQLite runs here (better-sqlite3 is alias-mocked; applySqlBatch is not unit-testable — see the
// plan's Testing note). These pin: the four documented template statement shapes, every forbidden
// head is rejected by name, and the splitter respects string literals / comments / CJK.

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons and trims segments', () => {
    expect(splitSqlStatements('INSERT INTO a VALUES (1); UPDATE b SET x=1')).toEqual([
      'INSERT INTO a VALUES (1)',
      'UPDATE b SET x=1'
    ])
  })

  it('drops a trailing semicolon / empty segments', () => {
    expect(splitSqlStatements('DELETE FROM a;')).toEqual(['DELETE FROM a'])
    expect(splitSqlStatements(';;  ;')).toEqual([])
    expect(splitSqlStatements('')).toEqual([])
  })

  it('does NOT split on a semicolon inside a single-quoted literal', () => {
    const sql = "INSERT INTO a VALUES ('x;y;z')"
    expect(splitSqlStatements(sql)).toEqual([sql])
  })

  it('honors the doubled-quote ' + "'' escape inside a literal", () => {
    const sql = "INSERT INTO a VALUES ('it''s; fine')"
    expect(splitSqlStatements(sql)).toEqual([sql])
  })

  it('preserves CJK text and semicolons inside literals', () => {
    const sql = "UPDATE roleplay_guide SET note = '第一章；开始' WHERE row_id = 1"
    expect(splitSqlStatements(sql)).toEqual([sql])
  })

  it('does NOT split on a semicolon inside a double-quoted identifier', () => {
    const sql = 'UPDATE "weird;name" SET x = 1'
    expect(splitSqlStatements(sql)).toEqual([sql])
  })

  it('ignores a semicolon in a -- line comment', () => {
    const sql = 'INSERT INTO a VALUES (1) -- drop; everything\n'
    expect(splitSqlStatements(sql)).toEqual(['INSERT INTO a VALUES (1)'])
  })

  it('ignores a semicolon in a /* block comment */', () => {
    const sql = 'INSERT INTO a VALUES (1) /* a; b; c */; UPDATE b SET x=1'
    expect(splitSqlStatements(sql)).toEqual(['INSERT INTO a VALUES (1)', 'UPDATE b SET x=1'])
  })

  it('splits a multi-statement batch with literals containing semicolons', () => {
    const sql = "INSERT INTO a VALUES ('a;b'); DELETE FROM c WHERE x = 'd;e'"
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO a VALUES ('a;b')",
      "DELETE FROM c WHERE x = 'd;e'"
    ])
  })
})

describe('classifyStatement — the four documented template shapes', () => {
  it('INSERT with a SELECT MAX(row_id)+1 subquery', () => {
    const sql =
      "INSERT INTO chronicle (row_id, code_index, summary) VALUES ((SELECT MAX(row_id)+1 FROM chronicle), 'AM0002', '事件')"
    expect(classifyStatement(sql)).toEqual({ kind: 'insert', table: 'chronicle' })
  })

  it('INSERT OR IGNORE', () => {
    const sql = "INSERT OR IGNORE INTO important_characters (character_name) VALUES ('莉莉丝')"
    expect(classifyStatement(sql)).toEqual({ kind: 'insert', table: 'important_characters' })
  })

  it('UPDATE with COALESCE string concatenation', () => {
    const sql =
      "UPDATE roleplay_guide SET guide = COALESCE(guide,'') || '\\n新增' WHERE character_name = '莉莉丝'"
    expect(classifyStatement(sql)).toEqual({ kind: 'update', table: 'roleplay_guide' })
  })

  it('DELETE with an ORDER BY / LIMIT subquery (capacity cleanup)', () => {
    const sql =
      'DELETE FROM foreshadow_table WHERE row_id IN (SELECT row_id FROM foreshadow_table ORDER BY row_id ASC LIMIT 1)'
    expect(classifyStatement(sql)).toEqual({ kind: 'delete', table: 'foreshadow_table' })
  })

  it('accepts a "quoted" target identifier and unquotes it', () => {
    expect(classifyStatement('INSERT INTO "chronicle" VALUES (1)')).toEqual({
      kind: 'insert',
      table: 'chronicle'
    })
  })

  it('is case-insensitive on the head keyword', () => {
    expect(classifyStatement('insert into a values (1)').kind).toBe('insert')
    expect(classifyStatement('Update a Set x=1').kind).toBe('update')
    expect(classifyStatement('DELETE from a where x=1').kind).toBe('delete')
  })

  it('reads the head past leading comments/whitespace', () => {
    const sql = '  -- log\n  /* c */ INSERT INTO chronicle VALUES (1)'
    expect(classifyStatement(sql)).toEqual({ kind: 'insert', table: 'chronicle' })
  })
})

describe('classifyStatement — forbidden heads rejected by name', () => {
  const forbidden: Array<[string, string]> = [
    ['SELECT', 'SELECT * FROM chronicle'],
    ['CREATE', 'CREATE TABLE evil (x)'],
    ['DROP', 'DROP TABLE chronicle'],
    ['ALTER', 'ALTER TABLE chronicle ADD COLUMN x'],
    ['ATTACH', "ATTACH DATABASE 'other.db' AS o"],
    ['DETACH', 'DETACH DATABASE o'],
    ['PRAGMA', 'PRAGMA foreign_keys = OFF'],
    ['BEGIN', 'BEGIN TRANSACTION'],
    ['COMMIT', 'COMMIT'],
    ['ROLLBACK', 'ROLLBACK'],
    ['SAVEPOINT', 'SAVEPOINT s1'],
    ['RELEASE', 'RELEASE s1'],
    ['VACUUM', 'VACUUM'],
    ['REINDEX', 'REINDEX chronicle'],
    ['WITH', 'WITH t AS (SELECT 1) INSERT INTO chronicle SELECT * FROM t'],
    ['EXPLAIN', 'EXPLAIN INSERT INTO chronicle VALUES (1)'],
    ['REPLACE', 'REPLACE INTO chronicle VALUES (1)']
  ]

  for (const [head, sql] of forbidden) {
    it(`rejects ${head} and names the head`, () => {
      let err: unknown
      try {
        classifyStatement(sql)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(TableSqlError)
      expect((err as Error).message).toContain(head)
    })
  }

  it('rejects an empty statement', () => {
    expect(() => classifyStatement('   ')).toThrow(TableSqlError)
  })

  it('rejects an unsafe (non-identifier) target table', () => {
    // A quoted identifier with a space is not a safe interpolatable name.
    expect(() => classifyStatement('INSERT INTO "a b" VALUES (1)')).toThrow(/Unsafe/)
  })
})

describe('validateBatch', () => {
  const allowed = new Set(['chronicle', 'roleplay_guide'])

  it('accepts a batch whose targets are all registered', () => {
    const batch =
      "INSERT INTO chronicle VALUES (1); UPDATE roleplay_guide SET g='x' WHERE row_id=1"
    const result = validateBatch(batch, allowed)
    expect(result.map((s) => s.table)).toEqual(['chronicle', 'roleplay_guide'])
    expect(result.map((s) => s.kind)).toEqual(['insert', 'update'])
  })

  it('returns [] for a blank/comment-only batch', () => {
    expect(validateBatch('  -- nothing\n', allowed)).toEqual([])
    expect(validateBatch('', allowed)).toEqual([])
  })

  it('rejects an unregistered target table with the offending statement index', () => {
    const batch = 'INSERT INTO chronicle VALUES (1); INSERT INTO secrets VALUES (2)'
    let err: unknown
    try {
      validateBatch(batch, allowed)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TableSqlError)
    expect((err as TableSqlError).index).toBe(1)
    expect((err as Error).message).toContain('secrets')
  })

  it('propagates a forbidden-head rejection with the statement index', () => {
    const batch = 'INSERT INTO chronicle VALUES (1); DROP TABLE chronicle'
    let err: unknown
    try {
      validateBatch(batch, allowed)
    } catch (e) {
      err = e
    }
    expect((err as TableSqlError).index).toBe(1)
    expect((err as Error).message).toContain('DROP')
  })
})
