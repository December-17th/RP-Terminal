import { describe, it, expect } from 'vitest'
import { applyRegexRules, isCardPayload, type RegexLikeRule } from '../src/shared/regexTransform'

const rule = (over: Partial<RegexLikeRule & { renderMode?: string }> = {}): any => ({
  source: 'X',
  flags: 'g',
  replace: '<html><body>card</body></html>',
  placement: [],
  trimStrings: [],
  ...over
})

describe('isCardPayload', () => {
  it('detects card-ish html payloads', () => {
    expect(isCardPayload('<html></html>')).toBe(true)
    expect(isCardPayload('```html\nx```')).toBe(true)
    expect(isCardPayload('<script>1</script>')).toBe(true)
    expect(isCardPayload('plain text')).toBe(false)
  })
})

describe('applyRegexRules marker option', () => {
  it('prepends the marker the callback returns', () => {
    const out = applyRegexRules('X', [rule({ renderMode: 'isolated' })], {}, {
      marker: (r: any) => (r.renderMode ? `<!--rpt:mode=${r.renderMode}-->` : undefined)
    })
    expect(out).toBe('<!--rpt:mode=isolated--><html><body>card</body></html>')
  })
  it('emits nothing when the callback returns undefined', () => {
    const out = applyRegexRules('X', [rule()], {}, { marker: () => undefined })
    expect(out).toBe('<html><body>card</body></html>')
  })
})
