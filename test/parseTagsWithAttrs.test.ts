import { describe, it, expect } from 'vitest'
import { extractTagAllWithAttrs } from '../src/main/services/nodes/builtin/parseNodes'

// PLOT-RECALL WP6 — the pure attribute-aware tag extractor beside extractTagAll. Powers the
// notes.maintain `<MemoryNote section= mode=>` parse; kept pure so it is unit-testable in isolation.

describe('extractTagAllWithAttrs', () => {
  it('parses quoted attributes (double AND single quotes) + inner content', () => {
    const out = extractTagAllWithAttrs(
      `<MemoryNote section="人物关系" mode='append'>阿尔忒弥斯 承认了秘密。</MemoryNote>`,
      'MemoryNote'
    )
    expect(out).toHaveLength(1)
    expect(out[0].attrs).toEqual({ section: '人物关系', mode: 'append' })
    expect(out[0].content).toBe('阿尔忒弥斯 承认了秘密。')
  })

  it('extracts multiple tags in order', () => {
    const raw = `noise
<MemoryNote section="A" mode="replace">first</MemoryNote>
mid
<MemoryNote section="B" mode="append">second</MemoryNote>`
    const out = extractTagAllWithAttrs(raw, 'MemoryNote')
    expect(out.map((m) => m.attrs.section)).toEqual(['A', 'B'])
    expect(out.map((m) => m.content)).toEqual(['first', 'second'])
  })

  it('lower-cases attribute keys so lookups are case-insensitive', () => {
    const out = extractTagAllWithAttrs(`<MemoryNote SECTION="X" Mode="Append">y</MemoryNote>`, 'MemoryNote')
    expect(out[0].attrs.section).toBe('X')
    expect(out[0].attrs.mode).toBe('Append')
  })

  it('a tag with no attributes → empty attrs, content captured', () => {
    const out = extractTagAllWithAttrs(`<MemoryNote>plain</MemoryNote>`, 'MemoryNote')
    expect(out).toEqual([{ attrs: {}, content: 'plain' }])
  })

  it('ignores unquoted attribute values (only quoted are captured)', () => {
    const out = extractTagAllWithAttrs(`<MemoryNote section=A mode="replace">z</MemoryNote>`, 'MemoryNote')
    expect(out[0].attrs).toEqual({ mode: 'replace' })
    expect(out[0].content).toBe('z')
  })

  it('malformed (never-closed) tag → []', () => {
    expect(extractTagAllWithAttrs(`<MemoryNote section="A">no closing tag`, 'MemoryNote')).toEqual([])
  })

  it('blank tag name or no match → []', () => {
    expect(extractTagAllWithAttrs('anything', '')).toEqual([])
    expect(extractTagAllWithAttrs('nothing here', 'MemoryNote')).toEqual([])
  })

  it('a missing `>` on the open tag cannot swallow the rest of the document', () => {
    // The attribute segment forbids `<`/`>`, so an unterminated open tag simply fails to match.
    expect(extractTagAllWithAttrs(`<MemoryNote section="A" body</MemoryNote>`, 'MemoryNote')).toEqual([])
  })
})
