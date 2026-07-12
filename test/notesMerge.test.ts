import { describe, it, expect } from 'vitest'
import {
  mergeNotes,
  parseNotesSections,
  parseNotesDocument
} from '../src/shared/memory/notesGrep'

describe('mergeNotes', () => {
  const EXISTING = `## Intro
<!-- keywords: alpha -->
Original intro body.

## Timeline
Day one happened.`

  it('creates a new section when the heading is unknown', () => {
    const out = mergeNotes(EXISTING, [{ heading: 'Cast', body: 'The heroine.' }])
    const sections = parseNotesSections(out)
    expect(sections.map((s) => s.heading)).toEqual(['Intro', 'Timeline', 'Cast'])
    expect(sections[2].body).toBe('The heroine.')
  })

  it('replaces the body by default (case-insensitive heading match)', () => {
    const out = mergeNotes(EXISTING, [{ heading: 'timeline', body: 'Day two happened.' }])
    const sections = parseNotesSections(out)
    const timeline = sections.find((s) => s.heading === 'Timeline')
    expect(timeline?.body).toBe('Day two happened.')
    expect(timeline?.body).not.toContain('Day one')
  })

  it('appends to the existing body when mode is append', () => {
    const out = mergeNotes(EXISTING, [
      { heading: 'Timeline', body: 'Day two happened.', mode: 'append' }
    ])
    const sections = parseNotesSections(out)
    const timeline = sections.find((s) => s.heading === 'Timeline')
    expect(timeline?.body).toContain('Day one happened.')
    expect(timeline?.body).toContain('Day two happened.')
  })

  it('preserves existing keywords when replacing the body', () => {
    const out = mergeNotes(EXISTING, [{ heading: 'Intro', body: 'New intro.' }])
    const sections = parseNotesSections(out)
    const intro = sections.find((s) => s.heading === 'Intro')
    expect(intro?.keywords).toEqual(['alpha'])
    expect(intro?.body).toBe('New intro.')
  })

  it('applies multiple edits in order and ignores blank headings', () => {
    const out = mergeNotes(EXISTING, [
      { heading: 'Timeline', body: 'Rewritten.', mode: 'replace' },
      { heading: '   ', body: 'dropped' },
      { heading: 'New', body: 'fresh' }
    ])
    const sections = parseNotesSections(out)
    expect(sections.map((s) => s.heading)).toEqual(['Intro', 'Timeline', 'New'])
    expect(sections.find((s) => s.heading === 'Timeline')?.body).toBe('Rewritten.')
  })

  it('round-trips: parse(merge(x)) is stable for a known section', () => {
    const once = mergeNotes(EXISTING, [{ heading: 'Cast', body: '甲乙丙' }])
    const twice = mergeNotes(once, [])
    expect(twice).toBe(once)
  })

  it('handles empty existing notes', () => {
    const out = mergeNotes('', [{ heading: 'First', body: 'body' }])
    expect(parseNotesSections(out)).toEqual([
      { heading: 'First', keywords: [], body: 'body' }
    ])
  })

  it('returns empty string when there is nothing to write', () => {
    expect(mergeNotes('', [])).toBe('')
    expect(mergeNotes(null, null)).toBe('')
  })

  describe('preamble preservation (B1)', () => {
    const WITH_PREAMBLE = `This is a hand-written intro paragraph.
It has two lines and no heading.

## Timeline
Day one happened.`

    it('captures pre-first-heading text as the document preamble', () => {
      const doc = parseNotesDocument(WITH_PREAMBLE)
      expect(doc.preamble).toBe(
        'This is a hand-written intro paragraph.\nIt has two lines and no heading.'
      )
      expect(doc.sections.map((s) => s.heading)).toEqual(['Timeline'])
    })

    it('preserves the preamble verbatim through a merge that edits a section', () => {
      const out = mergeNotes(WITH_PREAMBLE, [
        { heading: 'Timeline', body: 'Day two happened.' }
      ])
      expect(out).toContain('This is a hand-written intro paragraph.')
      expect(out).toContain('It has two lines and no heading.')
      // The preamble stays at the very top, before the first heading.
      expect(out.indexOf('This is a hand-written intro paragraph.')).toBeLessThan(
        out.indexOf('## Timeline')
      )
      // Round-trips stably: re-merging with no edits does not mangle the preamble.
      expect(mergeNotes(out, [])).toBe(out)
    })

    it('preserves the preamble when a new section is created', () => {
      const out = mergeNotes(WITH_PREAMBLE, [{ heading: 'Cast', body: 'The heroine.' }])
      expect(out).toContain('This is a hand-written intro paragraph.')
      expect(parseNotesSections(out).map((s) => s.heading)).toEqual(['Timeline', 'Cast'])
    })

    it('keeps a preamble-only file (no headings) instead of dropping it', () => {
      const out = mergeNotes('Just an intro, no headings yet.', [])
      expect(out).toBe('Just an intro, no headings yet.\n')
    })

    it('empty/blank preamble is a no-op — output byte-identical to the no-preamble path', () => {
      // Blank-only leading whitespace must not introduce newline drift.
      expect(parseNotesDocument('\n\n## Timeline\nDay one happened.').preamble).toBe('')
      const withLeadingBlanks = mergeNotes('\n\n## Timeline\nDay one happened.', [
        { heading: 'Timeline', body: 'Rewritten.' }
      ])
      const plain = mergeNotes('## Timeline\nDay one happened.', [
        { heading: 'Timeline', body: 'Rewritten.' }
      ])
      expect(withLeadingBlanks).toBe(plain)
      expect(plain).toBe('## Timeline\nRewritten.\n')
    })
  })
})
