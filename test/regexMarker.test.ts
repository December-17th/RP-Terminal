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
    const out = applyRegexRules(
      'X',
      [rule({ renderMode: 'isolated' })],
      {},
      {
        marker: (r: any) => (r.renderMode ? `<!--rpt:mode=${r.renderMode}-->` : undefined)
      }
    )
    expect(out).toBe('<!--rpt:mode=isolated--><html><body>card</body></html>')
  })
  it('emits nothing when the callback returns undefined', () => {
    const out = applyRegexRules('X', [rule()], {}, { marker: () => undefined })
    expect(out).toBe('<html><body>card</body></html>')
  })
})

describe('applyRegexRules freezePayloads (display-path payload protection)', () => {
  // A beautifier injects a card, then a later CLEANUP rule matches a tag that exists INSIDE the
  // injected card. This is the perf/mangling bug: without protection the cleanup rescans (and rewrites)
  // the finished card — on a real card that meant a ~148KB paste rescanned by a backtracking regex, a
  // multi-second render stall, AND ~42KB silently stripped out of the dashboard.
  const beautify = rule({ source: '<A>', replace: '```html\n<body><div>KEEP</div></body>\n```' })
  const cleanup = rule({ source: '<div>KEEP</div>', replace: '' })

  it('OFF (default): a later rule DOES match inside an injected card payload (nested — unchanged)', () => {
    const out = applyRegexRules('<A>', [beautify, cleanup])
    expect(out).not.toContain('<div>KEEP</div>') // cleanup reached inside the payload
  })

  it('ON: a later rule does NOT match inside an injected card payload (card preserved verbatim)', () => {
    const out = applyRegexRules('<A>', [beautify, cleanup], {}, { freezePayloads: true })
    expect(out).toContain('<div>KEEP</div>') // payload survived the cleanup
    expect(out).toContain('```html') // and the fenced card is intact
  })

  it('ON: a single card payload round-trips identically to OFF (freeze+restore is faithful)', () => {
    const off = applyRegexRules('<A>', [beautify])
    const on = applyRegexRules('<A>', [beautify], {}, { freezePayloads: true })
    expect(on).toBe(off)
  })

  it('ON: plain-text chaining still works — only CARD payloads are opaque, not every replacement', () => {
    // The safe-subset guarantee: "no nested regex" applied to ALL outputs would break this (→ 'dog');
    // scoping it to card payloads keeps ST-style normalize→beautify chains intact.
    const chain = [rule({ source: 'cat', replace: 'dog' }), rule({ source: 'dog', replace: 'fox' })]
    expect(applyRegexRules('cat', chain, {}, { freezePayloads: true })).toBe('fox')
  })

  it('ON: nested payloads restore correctly (a later card echoes an earlier card via {{match}})', () => {
    const a = rule({ source: '<A>', replace: '<body>AAA</body>' })
    const b = rule({ source: '\\S+', replace: '<body>[{{match}}]</body>' }) // card; echoes the (frozen) match
    const out = applyRegexRules('<A>', [a, b], {}, { freezePayloads: true })
    expect(out).toBe('<body>[<body>AAA</body>]</body>') // outer expands first, then the inner token
  })

  it('ON: disabled when the sentinel already appears in the input (cannot corrupt real text)', () => {
    const withSentinel = `<A>${String.fromCharCode(0xe000)}tail`
    const on = applyRegexRules(withSentinel, [beautify, cleanup], {}, { freezePayloads: true })
    const off = applyRegexRules(withSentinel, [beautify, cleanup])
    expect(on).toBe(off) // freezing bailed → identical to the unprotected path
  })

  it('ON: multiple INDEPENDENT payloads round-trip identically to OFF', () => {
    const rules = [0, 1, 2, 3, 4].map((i) =>
      rule({ source: `<C${i}>`, replace: `<body>C${i}</body>` })
    )
    const input = '<C0><C1><C2><C3><C4>'
    expect(applyRegexRules(input, rules, {}, { freezePayloads: true })).toBe(
      applyRegexRules(input, rules)
    )
  })

  it('ON: a later `\\d+` rule cannot corrupt the placeholder (token carries no ASCII digits)', () => {
    // Regression guard: an ASCII-index token would be shredded by a digit-stripping rule → the whole
    // card silently vanishes. With a PUA-encoded index the token is untouchable; the digits INSIDE the
    // (frozen) payload are protected too, so `PAY42` survives verbatim.
    const beaut = rule({ source: '<A>', replace: '<body>PAY42</body>' })
    const stripDigits = rule({ source: '\\d+', replace: 'X' })
    const out = applyRegexRules('<A>', [beaut, stripDigits], {}, { freezePayloads: true })
    expect(out).toBe('<body>PAY42</body>')
  })

  it('ON: two payloads + a digit rewrite do NOT remap onto the wrong payload', () => {
    const a = rule({ source: '<A>', replace: '<body>ONE</body>' })
    const b = rule({ source: '<B>', replace: '<body>TWO</body>' })
    const rewrite = rule({ source: '\\d', replace: '9' })
    const out = applyRegexRules('<A><B>', [a, b, rewrite], {}, { freezePayloads: true })
    expect(out).toBe('<body>ONE</body><body>TWO</body>')
  })

  it('ON: backstop — if a rule strips the raw PUA index, re-run un-frozen recovers the payload', () => {
    // The one way to mangle the token: a rule that strips the raw PUA range. The applier detects the
    // stray delimiter and re-runs without freezing, degrading to the exact un-frozen output (never lost).
    const beaut = rule({ source: '<A>', replace: '<body>Z</body>' })
    const cls = `[${String.fromCharCode(0xe010)}-${String.fromCharCode(0xe019)}]`
    const stripPua = rule({ source: cls, replace: '' })
    const out = applyRegexRules('<A>', [beaut, stripPua], {}, { freezePayloads: true })
    expect(out).toBe('<body>Z</body>') // recovered via the un-frozen backstop
    expect(out).not.toContain(String.fromCharCode(0xe000)) // no stray delimiter leaks
  })

  it('ON: marker + freeze — the render-mode marker is preserved and the card is protected', () => {
    const beaut = rule({ source: '<A>', replace: '```html\n<body><div>KEEP</div></body>\n```' })
    const strip = rule({ source: '<div>KEEP</div>', replace: '' })
    const out = applyRegexRules('<A>', [beaut, strip], {}, {
      freezePayloads: true,
      marker: () => '<!--rpt:mode=isolated-->'
    })
    expect(out).toContain('<!--rpt:mode=isolated-->') // marker survives
    expect(out).toContain('<div>KEEP</div>') // payload interior protected from the later strip
  })
})
