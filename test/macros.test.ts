import { describe, it, expect } from 'vitest'
import { expandMacros } from '../src/shared/macros'

const rng0 = (): number => 0 // deterministic: always the first choice / lowest die

describe('expandMacros (TH-5)', () => {
  it('expands identity macros', () => {
    expect(expandMacros('{{char}} meets {{user}}', { char: 'Mira', user: 'Ash' })).toBe(
      'Mira meets Ash'
    )
    expect(expandMacros('I am {{persona}}', { persona: 'a knight' })).toBe('I am a knight')
  })

  it('strips {{// comment }} macros (empty, inline, and multi-line)', () => {
    expect(expandMacros('{{//}}keep')).toBe('keep')
    expect(expandMacros('a {{// note here}} b')).toBe('a  b')
    expect(expandMacros('{{//声明：\n禁止传播}}正文', { user: 'x' })).toBe('正文')
    expect(expandMacros('{{// c是claude, g是Gemini}}\nGo', {})).toBe('\nGo')
    // not a comment — unknown macro is left intact
    expect(expandMacros('{{unknown}}')).toBe('{{unknown}}')
  })

  it('reads local + global variables', () => {
    expect(expandMacros('HP: {{getvar::hp}}', { vars: { hp: 80 } })).toBe('HP: 80')
    expect(expandMacros('{{getvar::stats.str}}', { vars: { stats: { str: 12 } } })).toBe('12')
    expect(expandMacros('{{getglobalvar::seen}}', { globals: { seen: 3 } })).toBe('3')
    expect(expandMacros('{{getvar::missing}}', { vars: {} })).toBe('')
  })

  it('setvar / addvar mutate the context and render empty', () => {
    const vars: Record<string, unknown> = { n: 1 }
    expect(expandMacros('{{setvar::name::Cora}}{{getvar::name}}', { vars })).toBe('Cora')
    expect(vars.name).toBe('Cora')
    expect(expandMacros('{{addvar::n::4}}{{getvar::n}}', { vars })).toBe('5')
    expect(vars.n).toBe(5)
  })

  it('roll / random / pick use the injected RNG', () => {
    expect(expandMacros('{{roll::2d6}}', { rng: rng0 })).toBe('2') // two 1s
    expect(expandMacros('{{roll::20}}', { rng: rng0 })).toBe('1')
    expect(expandMacros('{{random::a::b::c}}', { rng: rng0 })).toBe('a')
    expect(expandMacros('{{random::x,y,z}}', { rng: rng0 })).toBe('x')
    expect(expandMacros('{{pick::one::two}}', { rng: rng0 })).toBe('one')
  })

  it('supports newline / noop / comment', () => {
    expect(expandMacros('a{{newline}}b', {})).toBe('a\nb')
    expect(expandMacros('a{{noop}}b{{//}}c', {})).toBe('abc')
  })

  it('resolves nested macros', () => {
    expect(expandMacros('{{getvar::{{user}}}}', { user: 'alice', vars: { alice: 'hi' } })).toBe('hi')
  })

  it('leaves EJS tags and unknown macros untouched', () => {
    expect(expandMacros('<%= getvar("x") %> {{user}}', { user: 'A' })).toBe('<%= getvar("x") %> A')
    expect(expandMacros('{{mystery}}', {})).toBe('{{mystery}}')
  })
})
