import { describe, it, expect } from 'vitest'
import {
  overflowSeqs,
  pageNewestFirst,
  rowToRecord,
  clampLimit,
  RUN_HISTORY_CAP,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  RunHistoryRow
} from '../src/main/services/runHistoryStore'
import { StoredRunRecord, WorkflowRunTrace } from '../src/shared/workflow/trace'

// runHistoryStore (agent-packs plan WP2.3): persisted, ring-capped run history. The native
// better-sqlite3 binary can't load under plain Node (test/mocks/better-sqlite3.ts is a no-op stub),
// so — mirroring tableProgressService / agentPackStore — the SQL wrappers (appendRun/listRuns) are
// runtime-validated only, and the PURE logic that decides ring-cap pruning + newest-first cursor
// paging + row mapping is unit-tested directly here.

// ── A record builder ─────────────────────────────────────────────────────────────────────────────

const trace = (chatId: string, over: Partial<WorkflowRunTrace> = {}): WorkflowRunTrace => ({
  chatId,
  workflowId: 'wf',
  startedAt: 1000,
  durationMs: 42,
  ok: true,
  aborted: false,
  nodes: [],
  ...over
})

const rec = (chatId: string, seq: number, over: Partial<StoredRunRecord> = {}): StoredRunRecord => ({
  runId: `r${seq}`,
  seq,
  origin: 'turn',
  packIds: [],
  trace: trace(chatId),
  ...over
})

// ── overflowSeqs: the ring-cap decision (cap injectable so we test with a small ring) ──────────────

describe('overflowSeqs (ring cap)', () => {
  it('returns [] when at or under the cap', () => {
    expect(overflowSeqs([0, 1, 2], 3)).toEqual([])
    expect(overflowSeqs([0, 1], 3)).toEqual([])
    expect(overflowSeqs([], 3)).toEqual([])
  })

  it('drops the SMALLEST seqs beyond the cap, keeping the most recent `cap`', () => {
    // 5 seqs, cap 3 → drop the two smallest (0,1), keep 2,3,4.
    expect(overflowSeqs([0, 1, 2, 3, 4], 3)).toEqual([0, 1])
  })

  it('is order-independent (input seqs need not be sorted)', () => {
    expect(overflowSeqs([4, 0, 3, 1, 2], 3)).toEqual([0, 1])
  })

  it('with the production cap, 201 seqs prune exactly the oldest one', () => {
    const seqs = Array.from({ length: RUN_HISTORY_CAP + 1 }, (_, i) => i)
    expect(overflowSeqs(seqs, RUN_HISTORY_CAP)).toEqual([0])
  })
})

// ── pageNewestFirst: newest-first, beforeSeq cursor, limit ─────────────────────────────────────────

describe('pageNewestFirst (cursor paging)', () => {
  const chatA = [rec('a', 0), rec('a', 1), rec('a', 2), rec('a', 3), rec('a', 4)]

  it('newest-first, no cursor → the latest `limit` runs, largest seq first', () => {
    const page = pageNewestFirst(chatA, undefined, 2)
    expect(page.map((r) => r.seq)).toEqual([4, 3])
  })

  it('beforeSeq excludes seqs >= the cursor (strictly less than)', () => {
    // Page back from seq 3 → next two are 2, 1.
    const page = pageNewestFirst(chatA, 3, 2)
    expect(page.map((r) => r.seq)).toEqual([2, 1])
  })

  it('paging to the end returns the remaining runs then empties', () => {
    const first = pageNewestFirst(chatA, undefined, 2) // [4,3]
    const cursor1 = first[first.length - 1].seq // 3
    const second = pageNewestFirst(chatA, cursor1, 2) // [2,1]
    const cursor2 = second[second.length - 1].seq // 1
    const third = pageNewestFirst(chatA, cursor2, 2) // [0]
    expect(third.map((r) => r.seq)).toEqual([0])
    const fourth = pageNewestFirst(chatA, third[third.length - 1].seq, 2) // []
    expect(fourth).toEqual([])
  })

  it('input order is irrelevant (sorted by seq desc)', () => {
    const shuffled = [rec('a', 2), rec('a', 0), rec('a', 4), rec('a', 1), rec('a', 3)]
    expect(pageNewestFirst(shuffled, undefined, 3).map((r) => r.seq)).toEqual([4, 3, 2])
  })

  it('a non-positive limit yields an empty page', () => {
    expect(pageNewestFirst(chatA, undefined, 0)).toEqual([])
  })
})

// ── per-chat isolation: paging one chat never surfaces another's rows ──────────────────────────────

describe('per-chat isolation', () => {
  it('pages only the records handed in — a chat A page never contains chat B rows', () => {
    // The SQL wrapper filters WHERE chat_id = ?; the pure helper is fed only that chat's rows. A
    // record built for a different chat must not appear when we page chat A's list.
    const onlyA = [rec('a', 0), rec('a', 1)]
    const page = pageNewestFirst(onlyA, undefined, DEFAULT_PAGE_LIMIT)
    expect(page.every((r) => r.trace.chatId === 'a')).toBe(true)
    expect(page).toHaveLength(2)
  })
})

// ── clampLimit ─────────────────────────────────────────────────────────────────────────────────────

describe('clampLimit', () => {
  it('defaults an absent/invalid/non-positive limit', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT)
    expect(clampLimit(0)).toBe(DEFAULT_PAGE_LIMIT)
    expect(clampLimit(-5)).toBe(DEFAULT_PAGE_LIMIT)
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_PAGE_LIMIT)
  })

  it('floors a fractional limit and caps at MAX_PAGE_LIMIT', () => {
    expect(clampLimit(10.9)).toBe(10)
    expect(clampLimit(9999)).toBe(MAX_PAGE_LIMIT)
  })
})

// ── rowToRecord: raw DB row → StoredRunRecord ──────────────────────────────────────────────────────

describe('rowToRecord', () => {
  const baseRow = (over: Partial<RunHistoryRow> = {}): RunHistoryRow => ({
    chat_id: 'c1',
    seq: 7,
    run_id: 'run-7',
    started_at: 1000,
    origin: 'headless',
    pack_ids: JSON.stringify(['memoryKeeper']),
    trigger: 'cadence: every 3 floors',
    ok: 1,
    aborted: 0,
    duration_ms: 250,
    trace: JSON.stringify(trace('c1', { ok: true })),
    ...over
  })

  it('parses the trace + pack_ids blobs and threads origin/seq/runId/trigger', () => {
    const r = rowToRecord(baseRow())
    expect(r).toMatchObject({
      runId: 'run-7',
      seq: 7,
      origin: 'headless',
      packIds: ['memoryKeeper'],
      trigger: 'cadence: every 3 floors'
    })
    expect(r.trace.chatId).toBe('c1')
  })

  it('omits trigger when the column is NULL (a turn record)', () => {
    const r = rowToRecord(baseRow({ trigger: null, origin: 'turn', pack_ids: '[]' }))
    expect('trigger' in r).toBe(false)
    expect(r.packIds).toEqual([])
    expect(r.origin).toBe('turn')
  })
})
