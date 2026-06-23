import { describe, it, expect } from 'vitest'
import {
  toPointer,
  keyPointer,
  setVarOps,
  assignVarOps,
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
