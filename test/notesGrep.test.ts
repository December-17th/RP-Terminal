import { describe, it, expect } from 'vitest'
import {
  parseNotesSections,
  grepSections,
  formatHits
} from '../src/shared/memory/notesGrep'

const SAMPLE = `preamble text that is not in any section

## Star Rail Cast
<!-- keywords: 黑塔, Herta -->
黑塔是天才俱乐部的成员，同时也是空间站的所有者。
她的模拟宇宙研究举世闻名。

## Battle Log
The cat sat on the mat.
A category of enemies appeared.
The party won the fight.

## Locations
The Herta Space Station orbits a frozen planet.`

describe('parseNotesSections', () => {
  it('splits on ## headings, drops preamble, and extracts keyword metadata', () => {
    const sections = parseNotesSections(SAMPLE)
    expect(sections.map((s) => s.heading)).toEqual([
      'Star Rail Cast',
      'Battle Log',
      'Locations'
    ])
    expect(sections[0].keywords).toEqual(['黑塔', 'Herta'])
    // keyword comment line is stripped from the body
    expect(sections[0].body).not.toContain('keywords:')
    expect(sections[0].body).toContain('黑塔是天才俱乐部的成员')
  })

  it('handles empty / nullish input', () => {
    expect(parseNotesSections('')).toEqual([])
    expect(parseNotesSections(null)).toEqual([])
    expect(parseNotesSections(undefined)).toEqual([])
  })

  it('does not treat ### as a section split', () => {
    const sections = parseNotesSections('## Top\nbody\n### Sub heading stays in body')
    expect(sections).toHaveLength(1)
    expect(sections[0].body).toContain('### Sub heading stays in body')
  })
})

describe('grepSections', () => {
  const sections = parseNotesSections(SAMPLE)

  it('matches a CJK query inside Chinese prose (no word-boundary breakage)', () => {
    const hits = grepSections(sections, '黑塔')
    // matched via keyword AND body; keyword hit wins → whole section
    expect(hits).toHaveLength(1)
    expect(hits[0].section.heading).toBe('Star Rail Cast')
    expect(hits[0].whole).toBe(true)
  })

  it('matches CJK query present only in a body (not keyword/heading)', () => {
    const notes = parseNotesSections('## 事件\n昨夜黑塔造访了列车。')
    const hits = grepSections(notes, '黑塔')
    expect(hits).toHaveLength(1)
    expect(hits[0].whole).toBe(false)
    expect(hits[0].context).toContain('黑塔造访了列车')
  })

  it('heading hit surfaces the whole section', () => {
    const hits = grepSections(sections, 'Locations')
    expect(hits).toHaveLength(1)
    expect(hits[0].whole).toBe(true)
  })

  it('body hit returns grep -C context, not the whole section', () => {
    const hits = grepSections(sections, 'party', { context: 1 })
    expect(hits).toHaveLength(1)
    expect(hits[0].whole).toBe(false)
    expect(hits[0].context).toContain('The party won the fight')
    // with context 1, the preceding line is included but not the first line
    expect(hits[0].context).toContain('A category of enemies appeared')
    expect(hits[0].context).not.toContain('The cat sat on the mat')
  })

  it('Latin word-boundary is exact: cat does not match category', () => {
    const hits = grepSections(sections, 'cat')
    // "cat" only stands alone in the Battle Log ("The cat sat"), not inside "category"
    expect(hits).toHaveLength(1)
    expect(hits[0].section.heading).toBe('Battle Log')
    expect(hits[0].context).toContain('The cat sat on the mat')
  })

  it('word-boundary can be disabled to match substrings', () => {
    const hits = grepSections(sections, 'cat', { wordBoundary: false })
    // now both "cat" and "category" match
    expect(hits[0].context).toContain('category')
  })

  it('bad regex falls back to literal substring matching and never throws', () => {
    const notes = parseNotesSections('## Odd\nthis has a [unclosed bracket in it')
    expect(() => grepSections(notes, '[unclosed')).not.toThrow()
    const hits = grepSections(notes, '[unclosed')
    expect(hits).toHaveLength(1)
    expect(hits[0].context).toContain('[unclosed bracket')
  })

  it('empty / whitespace query yields no hits', () => {
    expect(grepSections(sections, '')).toEqual([])
    expect(grepSections(sections, '   ')).toEqual([])
  })

  it('is case-insensitive by default and respects caseSensitive', () => {
    expect(grepSections(sections, 'LOCATIONS')).toHaveLength(1)
    expect(grepSections(sections, 'LOCATIONS', { caseSensitive: true })).toHaveLength(0)
  })
})

describe('formatHits', () => {
  const sections = parseNotesSections(SAMPLE)

  it('renders whole-section hits with heading + full body', () => {
    const hits = grepSections(sections, 'Locations')
    const out = formatHits(hits)
    expect(out).toContain('## Locations')
    expect(out).toContain('frozen planet')
  })

  it('caps the number of sections', () => {
    const notes = parseNotesSections(
      '## A\nfoo one\n\n## B\nfoo two\n\n## C\nfoo three'
    )
    const hits = grepSections(notes, 'foo')
    expect(hits).toHaveLength(3)
    const out = formatHits(hits, { maxSections: 2 })
    expect(out).toContain('## A')
    expect(out).toContain('## B')
    expect(out).not.toContain('## C')
  })

  it('caps total characters', () => {
    const hits = grepSections(sections, 'Locations')
    const out = formatHits(hits, { maxChars: 12 })
    expect(out.length).toBeLessThanOrEqual(12)
  })
})
