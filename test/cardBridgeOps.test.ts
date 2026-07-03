import { describe, it, expect } from 'vitest'
import {
  toPointer,
  keyPointer,
  setVarOps,
  assignVarOps,
  deepVarOps,
  applySetOps,
  replaceStatDataOps
} from '../src/renderer/src/cardBridge/ops'

describe('toPointer', () => {
  it('converts a dot path to an RFC-6902 JSON Pointer', () => {
    expect(toPointer('a.b.c')).toBe('/a/b/c')
    expect(toPointer('hp')).toBe('/hp')
  })
  it('escapes ~ and / per the spec', () => {
    expect(toPointer('a/b')).toBe('/a~1b')
    expect(toPointer('a~b')).toBe('/a~0b')
  })
})

describe('keyPointer', () => {
  it('treats the whole string as one key (no dot-splitting)', () => {
    expect(keyPointer('a.b')).toBe('/a.b')
  })
})

describe('setVarOps', () => {
  it('builds one set op at a dot path, as a JSON Pointer', () => {
    expect(setVarOps('a.b.c', 5)).toEqual([{ op: 'set', path: '/a/b/c', value: 5 }])
  })
})

describe('assignVarOps', () => {
  it('sets each TOP-LEVEL key (keys are not dot-split)', () => {
    expect(assignVarOps({ x: 1, 'y.z': 2 })).toEqual([
      { op: 'set', path: '/x', value: 1 },
      { op: 'set', path: '/y.z', value: 2 }
    ])
  })
})

describe('deepVarOps (insertOrAssignVariables / insertVariables — deep merge)', () => {
  it('merge: emits a leaf set op per changed path, preserving sibling keys', () => {
    // Writing a partial nested object must NOT replace the whole top-level key (the 命定之诗 `date` bug).
    const cur = { date: { npcs: { a: 1 }, log: { deathCount: 0 } } }
    expect(deepVarOps(cur, { date: { log: { totalFPGained: 7 } } }, false)).toEqual([
      { op: 'set', path: '/date/log/totalFPGained', value: 7 }
    ])
  })

  it('merge: overwrites primitive/array/null leaves but recurses into nested objects', () => {
    expect(deepVarOps({}, { a: { b: 1, c: [1, 2] }, d: 5 }, false)).toEqual([
      { op: 'set', path: '/a/b', value: 1 },
      { op: 'set', path: '/a/c', value: [1, 2] },
      { op: 'set', path: '/d', value: 5 }
    ])
  })

  it('merge: an empty-object value creates the container only if absent (never wipes an existing map)', () => {
    expect(deepVarOps({ npcs: { a: 1 } }, { npcs: {} }, false)).toEqual([]) // no-op, preserves {a:1}
    expect(deepVarOps({}, { npcs: {} }, false)).toEqual([{ op: 'set', path: '/npcs', value: {} }])
  })

  it('insertOnly: fills only leaf paths absent from current (deep defaults, no overwrite)', () => {
    const cur = { date: { log: { deathCount: 0 } } } // has log.deathCount, missing log.illegalLevelUpId + npcs
    expect(deepVarOps(cur, { date: { npcs: {}, log: { deathCount: 9, illegalLevelUpId: [] } } }, true)).toEqual([
      { op: 'set', path: '/date/npcs', value: {} },
      { op: 'set', path: '/date/log/illegalLevelUpId', value: [] }
    ])
  })
})

describe('applySetOps', () => {
  it('applies leaf set ops onto a clone, preserving siblings (mirrors applyJsonPatch)', () => {
    const root = { date: { npcs: { a: 1 }, log: { deathCount: 0 } } }
    applySetOps(root, deepVarOps(root, { date: { log: { totalFPGained: 7 } } }, false))
    expect(root).toEqual({ date: { npcs: { a: 1 }, log: { deathCount: 0, totalFPGained: 7 } } })
  })
})

describe('replaceStatDataOps', () => {
  it('removes keys absent from next, then sets every key of next', () => {
    expect(replaceStatDataOps({ a: 1, b: 2 }, { b: 9, c: 3 })).toEqual([
      { op: 'remove', path: '/a' },
      { op: 'set', path: '/b', value: 9 },
      { op: 'set', path: '/c', value: 3 }
    ])
  })
  it('treats a missing current as empty', () => {
    expect(replaceStatDataOps(undefined, { a: 1 })).toEqual([{ op: 'set', path: '/a', value: 1 }])
  })
})
