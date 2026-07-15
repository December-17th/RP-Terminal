import { describe, it, expect } from 'vitest'
import {
  splitSqlStatements,
  classifyStatement,
  validateBatch,
  validateReadQuery,
  sanitizeSqlBatch,
  collectBoundedRows,
  MAX_QUERY_ROWS,
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

  // Regression: a reasoning model wraps its SQL in a ```sql fence and/or a <think> preamble. Before
  // sanitizeSqlBatch the fence's opening line became the first "statement" and was rejected as head
  // "(unknown)", dropping the WHOLE maintain cycle (erratic / partial table fills).
  it('accepts a ```sql-fenced batch (fence unwrapped before splitting)', () => {
    const batch = "```sql\nINSERT INTO chronicle VALUES (1);\nUPDATE roleplay_guide SET g='x' WHERE row_id=1\n```"
    const result = validateBatch(batch, allowed)
    expect(result.map((s) => s.kind)).toEqual(['insert', 'update'])
  })

  it('strips a <think> reasoning preamble before the SQL', () => {
    const batch = '<think>I should log the event.</think>\nINSERT INTO chronicle VALUES (1)'
    const result = validateBatch(batch, allowed)
    expect(result.map((s) => s.table)).toEqual(['chronicle'])
  })
})

describe('sanitizeSqlBatch', () => {
  it('leaves already-clean SQL untouched', () => {
    const sql = "INSERT INTO chronicle VALUES (1); UPDATE t SET a='b'"
    expect(sanitizeSqlBatch(sql)).toBe(sql)
  })

  it('unwraps a bare ``` fence and drops think blocks', () => {
    expect(sanitizeSqlBatch('```\nINSERT INTO chronicle VALUES (1)\n```')).toBe(
      'INSERT INTO chronicle VALUES (1)'
    )
    expect(sanitizeSqlBatch('<think>x</think>UPDATE t SET a=1')).toBe('UPDATE t SET a=1')
  })

  it('does NOT unwrap a fence that only opens mid-text (defensive: whole-batch fence only)', () => {
    // No closing fence ⇒ not a single fenced block ⇒ returned as-is (still rejected downstream, safely).
    const s = '```sql\nINSERT INTO chronicle VALUES (1)'
    expect(sanitizeSqlBatch(s)).toBe(s)
  })
})

describe('validateReadQuery — the read-only table.query gate (issue 05)', () => {
  const registered = new Set(['chronicle', 'roleplay_guide'])

  it('rewrites a bare registered table name to SELECT *', () => {
    expect(validateReadQuery('chronicle', registered)).toEqual({
      ok: true,
      sql: 'SELECT * FROM "chronicle"'
    })
  })

  it('rejects a bare name that is NOT registered', () => {
    const r = validateReadQuery('secrets', registered)
    expect(r.ok).toBe(false)
    expect(r.reason).not.toBe('empty')
  })

  it('accepts a single SELECT statement verbatim (case-insensitive head)', () => {
    expect(validateReadQuery('SELECT row_id, summary FROM chronicle WHERE row_id > 3', registered)).toEqual({
      ok: true,
      sql: 'SELECT row_id, summary FROM chronicle WHERE row_id > 3'
    })
    expect(validateReadQuery('  select 1', registered).ok).toBe(true)
  })

  it('reads the head past leading comments', () => {
    expect(validateReadQuery('/* c */ -- x\nSELECT * FROM chronicle', registered).ok).toBe(true)
  })

  it('a blank / whitespace / comment-only query is the silent-empty case', () => {
    expect(validateReadQuery('', registered)).toEqual({ ok: false, reason: 'empty' })
    expect(validateReadQuery('   ', registered)).toEqual({ ok: false, reason: 'empty' })
    expect(validateReadQuery('-- just a comment', registered)).toEqual({ ok: false, reason: 'empty' })
  })

  it('rejects a WITH (CTE) head — documented as out of contract', () => {
    const r = validateReadQuery('WITH t AS (SELECT 1) SELECT * FROM t', registered)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('WITH')
  })

  it('rejects write / PRAGMA heads', () => {
    expect(validateReadQuery('INSERT INTO chronicle VALUES (1)', registered).ok).toBe(false)
    expect(validateReadQuery('UPDATE chronicle SET x=1', registered).ok).toBe(false)
    expect(validateReadQuery('DELETE FROM chronicle', registered).ok).toBe(false)
    expect(validateReadQuery('PRAGMA table_info(chronicle)', registered).ok).toBe(false)
  })

  it('rejects a multi-statement query (no injection past a SELECT head)', () => {
    const r = validateReadQuery('SELECT * FROM chronicle; DROP TABLE chronicle', registered)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('single')
  })
})

// P1-5 — the row/byte ceiling that bounds a `table.query` result (executeReadQuery streams its cursor
// through this). Pure over any row iterable; a generator proves rows past the ceiling are never pulled.
describe('collectBoundedRows — table.query result ceiling (P1-5)', () => {
  const rowsUpTo = (n: number): unknown[][] => Array.from({ length: n }, (_, i) => [i])

  it('returns every row and truncated:false when under both ceilings', () => {
    const out = collectBoundedRows(rowsUpTo(3))
    expect(out.rows).toEqual([[0], [1], [2]])
    expect(out.truncated).toBe(false)
  })

  it('stops at the row ceiling and reports truncation', () => {
    const out = collectBoundedRows(rowsUpTo(MAX_QUERY_ROWS + 50), 10)
    expect(out.rows).toHaveLength(10)
    expect(out.truncated).toBe(true)
  })

  it('never pulls rows past the row ceiling (lazy cursor — generator would throw past N)', () => {
    let pulled = 0
    function* infinite(): Generator<unknown[]> {
      for (;;) {
        if (pulled >= 6) throw new Error('pulled too many rows')
        pulled++
        yield [pulled]
      }
    }
    const out = collectBoundedRows(infinite(), 5)
    expect(out.rows).toHaveLength(5)
    expect(out.truncated).toBe(true)
    // 5 kept + 1 lookahead that trips the cap = 6; the generator is never driven past that.
    expect(pulled).toBe(6)
  })

  it('stops at the byte ceiling and reports truncation', () => {
    const big = 'x'.repeat(200) // ~202 serialized bytes/row
    const rows = Array.from({ length: 100 }, () => [big])
    const out = collectBoundedRows(rows, MAX_QUERY_ROWS, 1000)
    expect(out.truncated).toBe(true)
    expect(out.rows.length).toBeGreaterThan(0)
    expect(out.rows.length).toBeLessThan(100)
  })

  it('always keeps at least one row even when a single row exceeds the byte ceiling', () => {
    const huge = 'x'.repeat(5000)
    const out = collectBoundedRows([[huge], [huge]], MAX_QUERY_ROWS, 100)
    expect(out.rows).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })

  it('CLIPS an oversized first row so the byte ceiling holds even for a single huge cell', () => {
    // Review P1: previously a lone multi-MB row was returned intact with truncated:false.
    const huge = 'x'.repeat(5000)
    const out = collectBoundedRows([[huge]], MAX_QUERY_ROWS, 100)
    expect(out.rows).toHaveLength(1)
    expect(out.truncated).toBe(true) // reported accurately even when it is the ONLY row
    const cell = out.rows[0][0] as string
    expect(cell.length).toBeLessThan(200) // clipped, not the 5000-char original
    expect(cell).toContain('…[clipped]')
    // Non-string cells clip via their JSON form.
    const objRow = collectBoundedRows([[{ big: 'y'.repeat(5000) }]] as unknown as Iterable<
      unknown[]
    >, MAX_QUERY_ROWS, 100)
    expect(objRow.truncated).toBe(true)
    expect(String(objRow.rows[0][0])).toContain('…[clipped]')
  })
})
