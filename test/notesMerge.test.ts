import { describe, it, expect } from 'vitest'
import { mergeNotes, parseNotesSections } from '../src/shared/memory/notesGrep'

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
})
