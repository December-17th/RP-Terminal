import { describe, it, expect } from 'vitest'
import {
  MEMORY_CAPABILITY,
  isMemoryPack,
  memoryPackRows,
  memoryPaneMode,
  maintenanceSummary,
  type MemoryPackInput,
  type TableStatusLike
} from '../src/renderer/src/components/workspace/memoryPaneModel'

// Pure derivations for the control-center Memory pane (agent-packs plan WP3.8). No IPC, no React.

describe('isMemoryPack', () => {
  it('is true only when the pack has the writes-tables capability', () => {
    expect(isMemoryPack(['writes-tables'])).toBe(true)
    expect(isMemoryPack([MEMORY_CAPABILITY, 'reads-lore'])).toBe(true)
    expect(isMemoryPack(['reads-lore'])).toBe(false)
    expect(isMemoryPack([])).toBe(false)
  })
})

describe('memoryPackRows', () => {
  const packs: MemoryPackInput[] = [
    { id: 'mem', name: 'Memory', capabilities: ['writes-tables'] },
    { id: 'lore', name: 'Lore', capabilities: ['reads-lore'] },
    { id: 'mem2', name: 'Memory 2', capabilities: ['writes-tables'] }
  ]

  it('keeps only memory packs, preserving input order', () => {
    const rows = memoryPackRows(packs, {})
    expect(rows.map((r) => r.id)).toEqual(['mem', 'mem2'])
  })

  it('resolves the gate state from the gate map (missing = closed)', () => {
    const rows = memoryPackRows(packs, { mem: true })
    expect(rows.find((r) => r.id === 'mem')?.enabled).toBe(true)
    expect(rows.find((r) => r.id === 'mem2')?.enabled).toBe(false)
  })
})

describe('memoryPaneMode', () => {
  it('no chat → no-chat (regardless of template)', () => {
    expect(memoryPaneMode({ hasChat: false, hasTemplate: false })).toBe('no-chat')
    expect(memoryPaneMode({ hasChat: false, hasTemplate: true })).toBe('no-chat')
  })
  it('chat but no template → no-template', () => {
    expect(memoryPaneMode({ hasChat: true, hasTemplate: false })).toBe('no-template')
  })
  it('chat with template → configured', () => {
    expect(memoryPaneMode({ hasChat: true, hasTemplate: true })).toBe('configured')
  })
})

describe('maintenanceSummary', () => {
  const st = (unprocessed: number): TableStatusLike => ({
    lastFloor: 0,
    processed: 0,
    nextExpected: 1,
    unprocessed
  })

  it('empty status → no tables, no backlog', () => {
    const s = maintenanceSummary({})
    expect(s).toEqual({ tableCount: 0, maxUnprocessed: 0, hasBacklog: false })
  })

  it('takes the max unprocessed across tables and flags a backlog', () => {
    const s = maintenanceSummary({ a: st(0), b: st(4), c: st(2) })
    expect(s.tableCount).toBe(3)
    expect(s.maxUnprocessed).toBe(4)
    expect(s.hasBacklog).toBe(true)
  })

  it('all tables caught up → no backlog', () => {
    const s = maintenanceSummary({ a: st(0), b: st(0) })
    expect(s.hasBacklog).toBe(false)
    expect(s.maxUnprocessed).toBe(0)
  })
})
