import { describe, it, expect } from 'vitest'
import { computeTableProgress } from '../src/main/services/tableProgressService'

// Pure progress derivation (issue 07). The SQL wrappers (get/advance/clamp/reset) follow the
// established untestable stance (better-sqlite3 is alias-mocked); the clamp/reset rewind hooks are
// exercised through chatService in the owner's manual pass. Here we pin the display formula's edges.

describe('computeTableProgress', () => {
  it('never-processed table (last -1): processed 0; nextExpected = freq-1 for freq 1', () => {
    // freq 1 → nextExpected 0 (floor 0 fires it). currentFloor -1 (empty chat) → unprocessed 0.
    expect(computeTableProgress(undefined, 1, -1)).toEqual({
      processed: 0,
      nextExpected: 0,
      unprocessed: 0
    })
  })

  it('never-processed, freq 3: nextExpected 2 (three floors 0,1,2 must elapse)', () => {
    expect(computeTableProgress(undefined, 3, 5)).toEqual({
      processed: 0,
      nextExpected: 2,
      // currentFloor 5, last -1 → 6 floors (0..5) unprocessed.
      unprocessed: 6
    })
  })

  it('processed through floor 4, freq 1, currentFloor 7', () => {
    expect(computeTableProgress(4, 1, 7)).toEqual({
      processed: 5, // floors 0..4
      nextExpected: 5, // last + freq
      unprocessed: 3 // 7 - 4
    })
  })

  it('processed through floor 4, freq 3, currentFloor 4 (fully caught up)', () => {
    expect(computeTableProgress(4, 3, 4)).toEqual({
      processed: 5,
      nextExpected: 7, // won't fire until floor 7
      unprocessed: 0 // 4 - 4
    })
  })

  it('unprocessed never goes negative (pointer ahead of currentFloor)', () => {
    // A pointer somehow ahead of the last floor (e.g. mid-rewind) → clamp unprocessed at 0.
    expect(computeTableProgress(9, 1, 2).unprocessed).toBe(0)
  })
})
