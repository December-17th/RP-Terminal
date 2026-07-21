import { describe, it, expect } from 'vitest'
import { diffLines, diffLineArrays, splitLines } from '../src/renderer/src/lib/lineDiff'

describe('lineDiff util (Microscope-lite D5)', () => {
  describe('splitLines', () => {
    it('treats an empty string as zero lines', () => {
      expect(splitLines('')).toEqual([])
    })
    it('splits on newlines and keeps a trailing empty segment', () => {
      expect(splitLines('a\nb')).toEqual(['a', 'b'])
      expect(splitLines('a\n')).toEqual(['a', ''])
    })
  })

  describe('diffLines', () => {
    it('reports nothing but context for identical inputs', () => {
      const rows = diffLines('a\nb\nc', 'a\nb\nc')
      expect(rows.every((r) => r.kind === 'context')).toBe(true)
      expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'c'])
    })

    it('marks every line added when before is empty', () => {
      expect(diffLines('', 'x\ny')).toEqual([
        { kind: 'add', text: 'x' },
        { kind: 'add', text: 'y' }
      ])
    })

    it('marks every line removed when after is empty', () => {
      expect(diffLines('x\ny', '')).toEqual([
        { kind: 'remove', text: 'x' },
        { kind: 'remove', text: 'y' }
      ])
    })

    it('emits no rows when both sides are empty', () => {
      expect(diffLines('', '')).toEqual([])
    })

    it('keeps common lines as context and flags the changed line', () => {
      // LCS keeps a + c; the middle line is a remove/add pair.
      const rows = diffLines('a\nb\nc', 'a\nB\nc')
      expect(rows).toEqual([
        { kind: 'context', text: 'a' },
        { kind: 'remove', text: 'b' },
        { kind: 'add', text: 'B' },
        { kind: 'context', text: 'c' }
      ])
    })

    it('detects a pure insertion in the middle', () => {
      const rows = diffLineArrays(['a', 'c'], ['a', 'b', 'c'])
      expect(rows).toEqual([
        { kind: 'context', text: 'a' },
        { kind: 'add', text: 'b' },
        { kind: 'context', text: 'c' }
      ])
    })

    it('detects a pure deletion in the middle', () => {
      const rows = diffLineArrays(['a', 'b', 'c'], ['a', 'c'])
      expect(rows).toEqual([
        { kind: 'context', text: 'a' },
        { kind: 'remove', text: 'b' },
        { kind: 'context', text: 'c' }
      ])
    })

    it('reconstructs the after-text from context + add rows', () => {
      const before = 'one\ntwo\nthree\nfour'
      const after = 'one\ntwo-changed\nthree\nfive\nfour'
      const rows = diffLineArrays(splitLines(before), splitLines(after))
      const rebuilt = rows.filter((r) => r.kind !== 'remove').map((r) => r.text)
      expect(rebuilt).toEqual(splitLines(after))
      const original = rows.filter((r) => r.kind !== 'add').map((r) => r.text)
      expect(original).toEqual(splitLines(before))
    })
  })
})
