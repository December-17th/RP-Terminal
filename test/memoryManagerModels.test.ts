import { describe, it, expect } from 'vitest'
import {
  groupOpsByFloor,
  rewindConsequence,
  type HistoryOp
} from '../src/renderer/src/components/memory/historyModel'
import {
  describeStagedOp,
  droppedTableUids,
  droppedColumns,
  canStage,
  type StructOp
} from '../src/renderer/src/components/memory/structureStaging'

// Pure models behind the Memory Manager's History timeline + staged Structure migration
// (table-refill WS6 Phase C). No IPC, no React.

const op = (floor: number, seq: number, extra: Partial<HistoryOp> = {}): HistoryOp => ({
  floor,
  seq,
  kind: 'insert',
  table: 't',
  createdAt: null,
  source: null,
  ...extra
})

describe('groupOpsByFloor', () => {
  it('groups the newest-first list into consecutive floor groups', () => {
    const groups = groupOpsByFloor([op(9, 1), op(9, 0), op(4, 0), op(0, 2), op(0, 1)])
    expect(groups.map((g) => g.floor)).toEqual([9, 4, 0])
    expect(groups[0].ops).toHaveLength(2)
    expect(groups[2].ops).toHaveLength(2)
  })
  it('a group takes the newest non-null createdAt as its time', () => {
    const groups = groupOpsByFloor([
      op(5, 2, { createdAt: null }),
      op(5, 1, { createdAt: '2026-07-14T00:00:00Z' }),
      op(5, 0, { createdAt: '2026-07-13T00:00:00Z' })
    ])
    expect(groups[0].time).toBe('2026-07-14T00:00:00Z')
  })
  it('empty ops → no groups', () => {
    expect(groupOpsByFloor([])).toEqual([])
  })
})

describe('rewindConsequence', () => {
  const ops = [op(9, 0), op(7, 1), op(7, 0), op(3, 0)]
  it('counts dropped ops and their distinct floors at/after the cut', () => {
    expect(rewindConsequence(ops, 7)).toEqual({ opsDropped: 3, floorsAffected: 2 })
    expect(rewindConsequence(ops, 0)).toEqual({ opsDropped: 4, floorsAffected: 3 })
    expect(rewindConsequence(ops, 10)).toEqual({ opsDropped: 0, floorsAffected: 0 })
  })
})

describe('structure staging', () => {
  const dropT: StructOp = { kind: 'dropTable', uid: 'u1' }
  const dropC: StructOp = { kind: 'dropColumn', uid: 'u2', name: 'hp' }

  it('describeStagedOp yields a localizable key + params per op kind', () => {
    expect(describeStagedOp({ kind: 'renameTable', uid: 'u1', sqlName: 's', displayName: 'New' }, '旧表'))
      .toEqual({ key: 'memoryManager.structure.staged.renameTable', params: { from: '旧表', to: 'New' } })
    expect(describeStagedOp(dropC, '人物表').params).toEqual({ table: '人物表', name: 'hp' })
  })

  it('tracks dropped tables/columns for the strike-through + disable treatment', () => {
    expect(droppedTableUids([dropT, dropC]).has('u1')).toBe(true)
    expect(droppedTableUids([dropT, dropC]).has('u2')).toBe(false)
    expect(droppedColumns([dropC], 'u2').has('hp')).toBe(true)
    expect(droppedColumns([dropC], 'u1').size).toBe(0)
  })

  it('canStage refuses ops on a dropped table and duplicate column drops', () => {
    expect(canStage([dropT], { kind: 'addColumn', uid: 'u1', name: 'x' })).toBe(false)
    expect(canStage([dropT], dropT)).toBe(false) // duplicate dropTable is a no-op
    expect(canStage([dropC], dropC)).toBe(false) // duplicate dropColumn
    expect(canStage([dropT], { kind: 'addColumn', uid: 'u2', name: 'x' })).toBe(true)
    expect(canStage([], dropT)).toBe(true)
  })
})
