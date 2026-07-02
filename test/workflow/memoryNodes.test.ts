import { describe, it, expect, vi, beforeEach } from 'vitest'

// D5 decomposed memory nodes: gate claims the slot + fires on a due batch; extract fires done /
// throws onto its error path (releasing the slot); write applies + always releases the slot.

const svc = vi.hoisted(() => ({
  compactionDue: vi.fn(),
  extractCompaction: vi.fn(),
  writeCompaction: vi.fn(),
  tryBeginCompaction: vi.fn(),
  endCompaction: vi.fn()
}))
vi.mock('../../src/main/services/compactionService', () => svc)

import {
  memoryGate,
  memoryExtract,
  memoryWrite
} from '../../src/main/services/nodes/builtin/memoryNodes'
import { NodeRunFailure, RunContext } from '../../src/main/services/nodes/types'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}
const gen = { profileId: 'p1', chatId: 'c1' }
const batch = { colls: [], floors: [{ floor: 0 }], range: { start: 0, end: 1 } }

beforeEach(() => {
  svc.compactionDue.mockReset()
  svc.extractCompaction.mockReset()
  svc.writeCompaction.mockReset()
  svc.tryBeginCompaction.mockReset().mockReturnValue(true)
  svc.endCompaction.mockReset()
})

describe('memory.gate', () => {
  it('fires due + emits the batch when a checkpoint is due (slot stays claimed)', async () => {
    svc.compactionDue.mockReturnValue(batch)
    const r = await memoryGate.run(ctx, { gen })
    expect(r).toEqual({ outputs: { batch }, signals: ['due'] })
    expect(svc.endCompaction).not.toHaveBeenCalled() // released by write / a failing extract
  })

  it('stays silent and releases the slot when nothing is due', async () => {
    svc.compactionDue.mockReturnValue(null)
    const r = await memoryGate.run(ctx, { gen })
    expect(r).toEqual({ outputs: {} })
    expect(svc.endCompaction).toHaveBeenCalledWith('c1')
  })

  it('never double-runs: an in-flight compaction blocks the gate', async () => {
    svc.tryBeginCompaction.mockReturnValue(false)
    const r = await memoryGate.run(ctx, { gen })
    expect(r).toEqual({ outputs: {} })
    expect(svc.compactionDue).not.toHaveBeenCalled()
  })
})

describe('memory.extract', () => {
  it('fires done with the parsed memories on success', async () => {
    const parsed = { parsed: true, streams: {}, entities: {} }
    svc.extractCompaction.mockResolvedValue(parsed)
    const r = await memoryExtract.run(ctx, { gen, batch })
    expect(r).toEqual({ outputs: { memories: parsed, batch }, signals: ['done'] })
  })

  it('a call failure releases the slot and throws class A', async () => {
    svc.extractCompaction.mockRejectedValue(new Error('utility timeout'))
    const err = await Promise.resolve(memoryExtract.run(ctx, { gen, batch })).catch((e) => e)
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect(err.kind).toBe('A')
    expect(svc.endCompaction).toHaveBeenCalledWith('c1')
  })

  it('an unparseable reply defers as class B (pointer untouched, slot released)', async () => {
    svc.extractCompaction.mockResolvedValue({ parsed: false, streams: {}, entities: {} })
    const err = await Promise.resolve(memoryExtract.run(ctx, { gen, batch })).catch((e) => e)
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect(err.kind).toBe('B')
    expect(err.code).toBe('parse')
    expect(svc.endCompaction).toHaveBeenCalledWith('c1')
    expect(svc.writeCompaction).not.toHaveBeenCalled()
  })
})

describe('memory.write', () => {
  it('applies the extraction and releases the slot', async () => {
    svc.writeCompaction.mockResolvedValue(3)
    const parsed = { parsed: true, streams: {}, entities: {} }
    const r = await memoryWrite.run(ctx, { gen, batch, memories: parsed })
    expect(svc.writeCompaction).toHaveBeenCalledWith('p1', 'c1', batch, parsed)
    expect(r).toEqual({ outputs: { count: 3 } })
    expect(svc.endCompaction).toHaveBeenCalledWith('c1')
  })

  it('releases the slot even when the write throws (error routes onward)', async () => {
    svc.writeCompaction.mockRejectedValue(new Error('db locked'))
    const err = await Promise.resolve(
      memoryWrite.run(ctx, { gen, batch, memories: {} })
    ).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(svc.endCompaction).toHaveBeenCalledWith('c1')
  })
})
