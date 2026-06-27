import { describe, it, expect } from 'vitest'
import { getPath, setPath } from '../src/shared/objectPath'
import { expandMacros } from '../src/shared/macros'

// Pins the TWO deliberate path dialects (WS-8) so a future "helpful" merge of the
// split-on-dot helpers into objectPath breaks loudly. See the header note in
// src/shared/objectPath.ts.

describe('path dialects (WS-8)', () => {
  describe('bracket-aware (objectPath — MVU stat_data / templateEngine)', () => {
    it('resolves a[0].b as an array index', () => {
      expect(getPath({ a: [{ b: 'INDEXED' }] }, 'a[0].b')).toBe('INDEXED')
    })
    it('writes through a bracket index', () => {
      const o: any = { a: [{ b: 1 }] }
      setPath(o, 'a[0].b', 9)
      expect(o.a[0].b).toBe(9)
    })
  })

  describe('split-on-dot (macros {{getvar}} — mirrors ST)', () => {
    it('treats a[0] as a LITERAL key, not an array index', () => {
      // The whole "a[0]" is one key; the macro reads vars['a[0]'].b.
      expect(expandMacros('{{getvar::a[0].b}}', { vars: { 'a[0]': { b: 'LITERAL' } } })).toBe(
        'LITERAL'
      )
    })
    it('does NOT index into a real array (the dialects differ here)', () => {
      // Same path, real array — split-on-dot can't reach it (vars['a[0]'] is undefined) → empty.
      expect(expandMacros('{{getvar::a[0].b}}', { vars: { a: [{ b: 'INDEXED' }] } })).toBe('')
    })
  })
})
