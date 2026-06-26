import { describe, it, expect } from 'vitest'
import {
  toRow,
  rowToEntry,
  rewindCompactionPointer,
  entryPatchToColumns,
  type MemoryRow
} from '../../src/main/services/memoryStore'

// The DB layer is a no-op stub under Node (see test/mocks/better-sqlite3.ts), so we test
// the pure data-shaping helpers — the part with real logic. The SQL wrappers are exercised
// at runtime (P4 manual e2e).

const NOW = '2026-06-26T00:00:00.000Z'

describe('toRow', () => {
  it('maps a minimal stream memory with defaults', () => {
    const r = toRow('chat1', 'events', { summary: 'X happened' }, NOW, 'id1')
    expect(r).toEqual({
      id: 'id1',
      chat_id: 'chat1',
      collection: 'events',
      entity_key: null,
      summary: 'X happened',
      payload: null,
      keywords: null,
      entities: null,
      salience: 1,
      pinned: 0,
      turn_start: null,
      turn_end: null,
      superseded_by: null,
      embed_model: null,
      updated_at: NOW,
      created_at: NOW
    })
  })

  it('JSON-encodes keywords/entities/payload and respects provided fields', () => {
    const r = toRow(
      'c',
      'events',
      {
        summary: 's',
        keywords: ['a', 'b'],
        entities: ['Ayaka'],
        payload: { k: 1 },
        salience: 0.8,
        pinned: true,
        turnStart: 3,
        turnEnd: 7
      },
      NOW,
      'id2'
    )
    expect(r.keywords).toBe('["a","b"]')
    expect(r.entities).toBe('["Ayaka"]')
    expect(r.payload).toBe('{"k":1}')
    expect(r.salience).toBe(0.8)
    expect(r.pinned).toBe(1)
    expect(r.turn_start).toBe(3)
    expect(r.turn_end).toBe(7)
  })

  it('stores empty keyword/entity arrays as null (no empty-JSON noise)', () => {
    const r = toRow('c', 'events', { summary: 's', keywords: [], entities: [] }, NOW, 'id3')
    expect(r.keywords).toBeNull()
    expect(r.entities).toBeNull()
  })

  it('generates a distinct uuid when no id is supplied', () => {
    const a = toRow('c', 'events', { summary: 's' }, NOW)
    const b = toRow('c', 'events', { summary: 's' }, NOW)
    expect(a.id).not.toBe(b.id)
    expect(a.id).toHaveLength(36)
  })
})

describe('rowToEntry', () => {
  const base: MemoryRow = {
    id: 'm1',
    chat_id: 'c1',
    collection: 'events',
    entity_key: null,
    summary: 's',
    payload: null,
    keywords: null,
    entities: null,
    salience: null,
    pinned: 0,
    turn_start: null,
    turn_end: null,
    superseded_by: null,
    embed_model: null,
    updated_at: null,
    created_at: null
  }

  it('parses JSON columns and applies defaults', () => {
    const e = rowToEntry({
      ...base,
      keywords: '["x","y"]',
      entities: '["Z"]',
      payload: '{"a":1}',
      salience: null,
      pinned: 1,
      turn_start: 2,
      turn_end: 4
    })
    expect(e.keywords).toEqual(['x', 'y'])
    expect(e.entities).toEqual(['Z'])
    expect(e.payload).toEqual({ a: 1 })
    expect(e.salience).toBe(1) // null → default 1
    expect(e.pinned).toBe(true)
    expect(e.turnStart).toBe(2)
    expect(e.turnEnd).toBe(4)
    expect(e.chatId).toBe('c1')
  })

  it('tolerates malformed/empty JSON (falls back to empty)', () => {
    const e = rowToEntry({ ...base, keywords: 'not json', entities: '' })
    expect(e.keywords).toEqual([])
    expect(e.entities).toEqual([])
    expect(e.payload).toBeNull()
  })

  it('round-trips toRow → rowToEntry', () => {
    const row = toRow(
      'c1',
      'events',
      { summary: 'hi', keywords: ['k'], salience: 0.5, turnStart: 1, turnEnd: 1 },
      NOW,
      'm9'
    )
    expect(rowToEntry(row)).toMatchObject({
      id: 'm9',
      chatId: 'c1',
      collection: 'events',
      summary: 'hi',
      keywords: ['k'],
      salience: 0.5,
      turnStart: 1,
      turnEnd: 1,
      pinned: false
    })
  })

  it('preserves salience 0 (not coerced to the default 1)', () => {
    // ?? guards null/undefined only, so an explicit 0 must survive both directions.
    expect(toRow('c', 'events', { summary: 's', salience: 0 }, NOW, 'i').salience).toBe(0)
    expect(rowToEntry({ ...base, salience: 0 }).salience).toBe(0)
  })

  it('carries entity_key + a nested payload through the round-trip', () => {
    const row = toRow(
      'c1',
      'characters',
      { summary: 'sheet', entityKey: 'ayaka', payload: { goals: ['find brother'], rank: 3 } },
      NOW,
      'm1'
    )
    expect(row.entity_key).toBe('ayaka')
    const e = rowToEntry(row)
    expect(e.entityKey).toBe('ayaka')
    expect(e.payload).toEqual({ goals: ['find brother'], rank: 3 })
  })
})

describe('entryPatchToColumns', () => {
  it('includes only provided fields', () => {
    expect(entryPatchToColumns({})).toEqual({})
    expect(entryPatchToColumns({ summary: 'new' })).toEqual({ summary: 'new' })
  })

  it('keeps an explicit empty-string summary (undefined-gated, not falsy-gated)', () => {
    expect(entryPatchToColumns({ summary: '' })).toEqual({ summary: '' })
  })

  it('JSON-encodes keywords and nulls an empty list', () => {
    expect(entryPatchToColumns({ keywords: ['a', 'b'] })).toEqual({ keywords: '["a","b"]' })
    expect(entryPatchToColumns({ keywords: [] })).toEqual({ keywords: null })
  })

  it('coerces pinned to 0/1', () => {
    expect(entryPatchToColumns({ pinned: true })).toEqual({ pinned: 1 })
    expect(entryPatchToColumns({ pinned: false })).toEqual({ pinned: 0 })
  })

  it('combines fields', () => {
    expect(entryPatchToColumns({ summary: 's', keywords: ['k'], pinned: true })).toEqual({
      summary: 's',
      keywords: '["k"]',
      pinned: 1
    })
  })
})

describe('rewindCompactionPointer', () => {
  it('rewinds to one before the cut when the pointer is at/after it', () => {
    expect(rewindCompactionPointer(10, 5)).toBe(4) // compacted through 10, cut at 5 → back to 4
    expect(rewindCompactionPointer(5, 5)).toBe(4) // boundary: cut exactly at the pointer
  })

  it('leaves the pointer unchanged when the cut is within the still-verbatim range', () => {
    expect(rewindCompactionPointer(5, 8)).toBeNull() // cut after everything compacted
    expect(rewindCompactionPointer(-1, 0)).toBeNull() // nothing compacted yet
  })
})
