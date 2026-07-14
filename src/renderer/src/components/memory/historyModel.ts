// Pure derivations for the Memory Manager's History tab (table-refill WS6 Phase C): the flat
// newest-first op projection (`chat-tables-ops-list`) becomes a floor-grouped timeline (the Linear
// activity-feed shape from the design brief), and the rewind confirm states its consequence
// ("drops N ops across M floors") instead of a bare "are you sure". React-free, pinned by
// test/memoryManagerModels.test.ts.

/** One op as `listChatTableOps` projects it (WS1 added `source`; null = pre-column legacy row). */
export interface HistoryOp {
  floor: number
  seq: number
  kind: 'insert' | 'update' | 'delete' | 'other'
  table: string | null
  createdAt: string | null
  source: 'maintain' | 'backfill' | 'edit' | 'baseline' | 'refill' | null
}

export interface FloorGroup {
  floor: number
  /** The group's display time: the NEWEST non-null createdAt among its ops (input is newest-first). */
  time: string | null
  ops: HistoryOp[]
}

/** Group the newest-first op list into consecutive floor groups (newest floor first — the input's
 *  own order, which `listChatTableOps` guarantees by `ORDER BY floor DESC, seq DESC`). */
export const groupOpsByFloor = (ops: HistoryOp[]): FloorGroup[] => {
  const groups: FloorGroup[] = []
  for (const op of ops) {
    const last = groups[groups.length - 1]
    if (last && last.floor === op.floor) {
      last.ops.push(op)
      if (last.time == null) last.time = op.createdAt
    } else {
      groups.push({ floor: op.floor, time: op.createdAt, ops: [op] })
    }
  }
  return groups
}

export interface RewindConsequence {
  /** Ops the cut at `fromFloor` would drop (floor ≥ fromFloor). */
  opsDropped: number
  /** Distinct floors those ops span. */
  floorsAffected: number
}

/** What a rewind cut at `fromFloor` costs — the ConfirmDialog's honesty line. */
export const rewindConsequence = (ops: HistoryOp[], fromFloor: number): RewindConsequence => {
  const floors = new Set<number>()
  let n = 0
  for (const op of ops) {
    if (op.floor >= fromFloor) {
      n++
      floors.add(op.floor)
    }
  }
  return { opsDropped: n, floorsAffected: floors.size }
}
