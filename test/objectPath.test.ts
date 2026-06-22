import { describe, it, expect } from 'vitest'
import {
  toParts,
  getPath,
  setPath,
  delPath,
  clone,
  deepMerge,
  isPlainObject
} from '../src/shared/objectPath'

describe('objectPath', () => {
  describe('toParts', () => {
    it('splits dotted paths', () => {
      expect(toParts('a.b.c')).toEqual(['a', 'b', 'c'])
    })
    it('expands bracket indices to keys', () => {
      expect(toParts('a[0].b')).toEqual(['a', '0', 'b'])
      expect(toParts('list[2]')).toEqual(['list', '2'])
    })
    it('drops empty segments', () => {
      expect(toParts('')).toEqual([])
      expect(toParts('a..b')).toEqual(['a', 'b'])
    })
  })

  describe('getPath', () => {
    const o = { a: { b: { c: 42 } }, list: [{ x: 1 }] }
    it('reads nested values, incl. bracket indices', () => {
      expect(getPath(o, 'a.b.c')).toBe(42)
      expect(getPath(o, 'list[0].x')).toBe(1)
    })
    it('returns undefined for missing paths', () => {
      expect(getPath(o, 'a.z.c')).toBeUndefined()
      expect(getPath(o, 'nope')).toBeUndefined()
    })
    it('returns the root for null/empty/undefined paths', () => {
      expect(getPath(o, null)).toBe(o)
      expect(getPath(o, '')).toBe(o)
      expect(getPath(o, undefined)).toBe(o)
    })
    it('does not throw when traversing through a primitive', () => {
      expect(getPath({ a: 5 }, 'a.b.c')).toBeUndefined()
    })
  })

  describe('setPath', () => {
    it('sets a nested value, creating intermediates', () => {
      const o: Record<string, unknown> = {}
      setPath(o, 'a.b.c', 7)
      expect(o).toEqual({ a: { b: { c: 7 } } })
    })
    it('overwrites a non-object intermediate', () => {
      const o: Record<string, unknown> = { a: 5 }
      setPath(o, 'a.b', 9)
      expect(o).toEqual({ a: { b: 9 } })
    })
    it('honors bracket indices as keys', () => {
      const o: Record<string, unknown> = {}
      setPath(o, 'a[0]', 'x')
      expect((o.a as Record<string, unknown>)['0']).toBe('x')
    })
  })

  describe('delPath', () => {
    it('deletes a leaf', () => {
      const o = { a: { b: 1, c: 2 } }
      delPath(o, 'a.b')
      expect(o).toEqual({ a: { c: 2 } })
    })
    it('is a no-op for a missing parent path', () => {
      const o = { a: {} }
      expect(() => delPath(o, 'x.y.z')).not.toThrow()
      expect(o).toEqual({ a: {} })
    })
  })

  describe('clone', () => {
    it('deep-copies and is independent of the source', () => {
      const src = { a: { b: [1, 2] } }
      const c = clone(src)
      c.a.b.push(3)
      expect(src.a.b).toEqual([1, 2])
    })
    it('passes undefined through', () => {
      expect(clone(undefined)).toBeUndefined()
    })
  })

  describe('isPlainObject', () => {
    it('accepts plain objects only', () => {
      expect(isPlainObject({})).toBe(true)
      expect(isPlainObject([])).toBe(false)
      expect(isPlainObject(null)).toBe(false)
      expect(isPlainObject(5)).toBe(false)
    })
  })

  describe('deepMerge', () => {
    it('merges nested objects', () => {
      const t: Record<string, unknown> = { a: { x: 1 }, keep: true }
      deepMerge(t, { a: { y: 2 } })
      expect(t).toEqual({ a: { x: 1, y: 2 }, keep: true })
    })
    it('replaces non-object values (including arrays)', () => {
      const t: Record<string, unknown> = { list: [1, 2], n: 1 }
      deepMerge(t, { list: [3], n: 5 })
      expect(t).toEqual({ list: [3], n: 5 })
    })
    it('deep-clones merged-in values (no shared refs)', () => {
      const src = { a: { b: 1 } }
      const t: Record<string, unknown> = {}
      deepMerge(t, src)
      ;(t.a as Record<string, unknown>).b = 99
      expect(src.a.b).toBe(1)
    })
  })
})
