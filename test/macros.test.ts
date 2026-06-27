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

  it('replaces legacy <USER>/<BOT>/<CHAR> (case-insensitive), like ST preEnvMacros', () => {
    expect(expandMacros('<user> meets <CHAR>', { user: 'Ash', char: 'Mira' })).toBe(
      'Ash meets Mira'
    )
    expect(expandMacros('<USER>/<Bot>', { user: 'Ash', char: 'Mira' })).toBe('Ash/Mira')
    expect(expandMacros('<CHARIFNOTGROUP>', { char: 'Mira' })).toBe('Mira')
    // empty context → empty string (never left literal)
    expect(expandMacros('hi <user>', {})).toBe('hi ')
    // does not touch unrelated angle-bracket text
    expect(expandMacros('a <div> b', { user: 'Ash' })).toBe('a <div> b')
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
    expect(expandMacros('{{getvar::{{user}}}}', { user: 'alice', vars: { alice: 'hi' } })).toBe(
      'hi'
    )
  })

  it('reads scoped variables via {{get_X_variable}} (global → globals; others → chat vars)', () => {
    const vars = { hp: 80, nested: { str: 12 } }
    expect(expandMacros('{{get_chat_variable::hp}}', { vars })).toBe('80')
    expect(expandMacros('{{get_message_variable::nested.str}}', { vars })).toBe('12')
    expect(expandMacros('{{get_character_variable::hp}}', { vars })).toBe('80')
    expect(expandMacros('{{get_preset_variable::hp}}', { vars })).toBe('80')
    expect(expandMacros('{{get_global_variable::seen}}', { globals: { seen: 3 } })).toBe('3')
    expect(expandMacros('{{get_chat_variable::missing}}', { vars })).toBe('')
  })

  it('formats objects/arrays as JSON via {{format_X_variable}}, primitives as strings', () => {
    const vars = { obj: { a: 1 }, list: [1, 2], n: 5, name: 'Cora' }
    expect(expandMacros('{{format_chat_variable::obj}}', { vars })).toBe('{"a":1}')
    expect(expandMacros('{{format_chat_variable::list}}', { vars })).toBe('[1,2]')
    expect(expandMacros('{{format_chat_variable::n}}', { vars })).toBe('5')
    expect(expandMacros('{{format_chat_variable::name}}', { vars })).toBe('Cora')
    expect(expandMacros('{{format_global_variable::g}}', { globals: { g: { x: true } } })).toBe(
      '{"x":true}'
    )
    expect(expandMacros('{{format_chat_variable::missing}}', { vars })).toBe('')
  })

  it('leaves EJS tags and unknown macros untouched', () => {
    expect(expandMacros('<%= getvar("x") %> {{user}}', { user: 'A' })).toBe('<%= getvar("x") %> A')
    expect(expandMacros('{{mystery}}', {})).toBe('{{mystery}}')
  })
})
