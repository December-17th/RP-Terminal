import { describe, it, expect } from 'vitest'
import { useRegexStore, RenderRegexRule } from '../src/renderer/src/stores/regexStore'

const rule = (over: Partial<RenderRegexRule>): RenderRegexRule => ({
  id: Math.random().toString(36).slice(2),
  scriptName: 's',
  source: 'x',
  flags: 'g',
  replace: '',
  placement: [2],
  disabled: false,
  markdownOnly: false,
  promptOnly: false,
  trimStrings: [],
  ...over
})

const apply = (
  text: string,
  rules: RenderRegexRule[],
  ctx?: { user?: string; char?: string }
): string => {
  useRegexStore.setState({ rules })
  return useRegexStore.getState().apply(text, ctx)
}

describe('regexStore.apply', () => {
  it('substitutes capture groups ($1, $2)', () => {
    expect(apply('a@b', [rule({ source: '(\\w+)@(\\w+)', replace: '$2.$1' })])).toBe('b.a')
  })

  it('{{match}} is the matched text with trimStrings removed', () => {
    const r = rule({
      source: '\\*\\*[^*]+\\*\\*',
      replace: '<b>{{match}}</b>',
      trimStrings: ['**']
    })
    expect(apply('hi **bold** there', [r])).toBe('hi <b>bold</b> there')
  })

  it('substitutes {{user}} and {{char}} from the context', () => {
    const r = rule({ source: 'NAME', replace: '{{user}} & {{char}}' })
    expect(apply('NAME', [r], { user: 'Lyra', char: 'Aria' })).toBe('Lyra & Aria')
  })

  it('converts \\n in the replacement to a real newline', () => {
    expect(apply('a|b', [rule({ source: '\\|', replace: '\\n' })])).toBe('a\nb')
  })

  it('substitutes $0 with the full match for ST regex compatibility', () => {
    const out = apply('<action_info>inner</action_info>', [
      rule({ source: '<action_info>([\\s\\S]*?)</action_info>', replace: 'full=$0; inner=$1' })
    ])
    expect(out).toBe('full=<action_info>inner</action_info>; inner=inner')
  })

  it('does NOT convert \\n inside a code payload (preserves a card script regex literal)', () => {
    // A beautification card whose <script> contains `/[\r\n]/g` must keep the \n literal — turning
    // it into a real newline splits the regex literal across lines (SyntaxError in the card).
    const card = '```html\n<body><script>x.replace(/[\\r\\n<>]/g, " ")</script></body>\n```'
    const out = apply('<tag>hi</tag>', [rule({ source: '<tag>.*?</tag>', replace: card })])
    expect(out).toContain('/[\\r\\n<>]/g') // backslash-n intact, not a literal newline
    expect(out).not.toMatch(/\[\\r\n/) // no newline injected inside the character class
  })

  it('leaves $N literal when the find-regex has no such group (native semantics)', () => {
    // A card script's own `$1` backreference must survive when our find-regex captured nothing.
    const out = apply('<tag>x</tag>', [
      rule({ source: '<tag>.*?</tag>', replace: '<script>s.replace(/a/, "$1")</script>' })
    ])
    expect(out).toContain('"$1"') // $1 preserved (no group 1 in the find-regex)
  })

  it('still substitutes $N inside a code payload when the group exists', () => {
    const out = apply('<tag>HELLO</tag>', [
      rule({ source: '<tag>(.*?)</tag>', replace: '<body><pre>$1</pre></body>' })
    ])
    expect(out).toContain('<pre>HELLO</pre>')
  })

  it('leaves $& / $0 literal inside a card payload (preserves the regex-escape idiom) while $N still injects', () => {
    // The real bug: a plot beautifier injects the whole match via $1, but the card's own <script>
    // contains the universal escape idiom `s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`. Substituting $&
    // there splices the ENTIRE matched block into the script (unterminated string → SyntaxError →
    // every handler undefined → a card that renders but won't expand on click). So $&/$0 must stay
    // literal in a card payload; the numbered-group injection ($1 into the textarea) must still work.
    const card =
      '```html\n<body><textarea>$1</textarea>' +
      "<script>const esc=(s)=>s.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&');const full='$0';</script></body>\n```"
    const out = apply('<用户本轮输入>PLOT</用户本轮输入>', [
      rule({ source: '(<用户本轮输入>[\\s\\S]*)', replace: card })
    ])
    expect(out).toContain("s.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')") // escape idiom intact
    expect(out).toContain("const full='$0';") // $0 left literal in the card script
    expect(out).toContain('<textarea><用户本轮输入>PLOT</用户本轮输入></textarea>') // $1 STILL injects
    expect(out).not.toMatch(/\\\\<用户本轮输入>/) // the whole match was NOT spliced into the escape idiom
  })

  it('still substitutes $& with the whole match in a plain-text (non-card) replacement', () => {
    // Non-card replacements keep native String.replace semantics — only card payloads are protected.
    expect(apply('abc', [rule({ source: 'b', replace: '[$&]' })])).toBe('a[b]c')
  })

  it('applies multiple rules in order', () => {
    const rules = [rule({ source: 'cat', replace: 'dog' }), rule({ source: 'dog', replace: 'fox' })]
    expect(apply('cat', rules)).toBe('fox')
  })
})
