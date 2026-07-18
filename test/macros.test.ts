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

// ST 1.18.0 NEW macro-engine profile (ADR 0016 decision 10; issue 13). Behavior matched from
// public/scripts/macros/engine/MacroEngine.js + definitions/*.js; RPT reimplements, copies nothing.
describe('expandMacros — ST new-engine profile', () => {
  const rng0 = (): number => 0 // deterministic lowest die / first choice

  it('resolves {{lastUserMessage}} to the supplied last user turn (chat-macros.js:108-111)', () => {
    expect(expandMacros('Recall: {{lastUserMessage}}', { lastUserMessage: 'where is the key?' })).toBe(
      'Recall: where is the key?'
    )
    // Absent context → empty (never left literal), like the ST macro over an empty chat.
    expect(expandMacros('[{{lastUserMessage}}]', {})).toBe('[]')
  })

  it('removes non-scoped {{trim}} AND the newlines around it (MacroEngine.js:310-316)', () => {
    expect(expandMacros('Block1\n\n{{trim}}\n\nBlock2')).toBe('Block1Block2')
    expect(expandMacros('a{{trim}}b')).toBe('ab')
    // Case-insensitive, like ST's /gi post-processor.
    expect(expandMacros('x\n{{TRIM}}\ny')).toBe('xy')
    // Only newlines are consumed — spaces stay (ST regex is (?:\r?\n)*).
    expect(expandMacros('p {{trim}} q')).toBe('p  q')
  })

  it('rolls legacy SPACE-form dice, not just the :: form (core-macros.js:303-337 / droll.js:58-107)', () => {
    expect(expandMacros('{{roll 1d20}}', { rng: rng0 })).toBe('1')
    expect(expandMacros('{{roll d20}}', { rng: rng0 })).toBe('1')
    expect(expandMacros('{{roll 1d999999}}', { rng: rng0 })).toBe('1')
    expect(expandMacros('{{roll:1d6}}', { rng: rng0 })).toBe('1') // single-colon separator
    // droll modifiers: three 1s + 4 = 7; two 1s - 1 = 1.
    expect(expandMacros('{{roll::3d6+4}}', { rng: rng0 })).toBe('7')
    expect(expandMacros('{{roll 2d6-1}}', { rng: rng0 })).toBe('1')
    // Invalid formula → empty (ST warns + returns '').
    expect(expandMacros('{{roll::nonsense}}', { rng: rng0 })).toBe('')
  })

  it('is case-insensitive for names, and space-separates args generally', () => {
    expect(expandMacros('{{USER}} / {{Char}}', { user: 'Ash', char: 'Mira' })).toBe('Ash / Mira')
    expect(expandMacros('{{Roll::2d6}}', { rng: rng0 })).toBe('2')
    expect(expandMacros('{{LastUserMessage}}', { lastUserMessage: 'hi' })).toBe('hi')
    expect(expandMacros('{{getvar hp}}', { vars: { hp: 7 } })).toBe('7') // space-form single arg
  })

  it('maps <GROUP>/<CHARIFNOTGROUP> and {{group}} to the char in solo assembly (MacroEnvBuilder.js:194)', () => {
    expect(expandMacros('{{group}}', { char: 'Mira' })).toBe('Mira')
    expect(expandMacros('{{charIfNotGroup}}', { char: 'Mira' })).toBe('Mira')
    expect(expandMacros('<GROUP> & <CHARIFNOTGROUP>', { char: 'Mira' })).toBe('Mira & Mira')
  })

  it('unescapes \\{ and \\} in post-processing so \\{\\{x\\}\\} emits a literal macro (MacroEngine.js:305-308)', () => {
    // Backslash-separated braces are never a macro opener; the backslashes are stripped after the passes.
    expect(expandMacros('\\{\\{user\\}\\}', { user: 'A' })).toBe('{{user}}')
    expect(expandMacros('cost is \\{50\\}')).toBe('cost is {50}')
  })

  it('preserves unknown/faulting macros literally (docs/rpt-api.md §7; MacroEngine.js:216-218)', () => {
    expect(expandMacros('{{not_a_macro}}', {})).toBe('{{not_a_macro}}')
    expect(expandMacros('a {{unknown::arg}} b', {})).toBe('a {{unknown::arg}} b')
  })

  describe('{{original}} — one-shot card-override macro (MacroEnvBuilder.js:144-151)', () => {
    it('resolves to the supplied original content', () => {
      expect(expandMacros('Extra rule.\n{{original}}', { original: 'BASE PROMPT' })).toBe(
        'Extra rule.\nBASE PROMPT'
      )
    })

    it('substitutes only ONCE per evaluation; later {{original}} is empty', () => {
      expect(expandMacros('{{original}}|{{original}}', { original: 'X' })).toBe('X|')
    })

    it('expands macros that were inside the original content (inlined then re-passed)', () => {
      expect(
        expandMacros('Prefix. {{original}}', { original: 'Hello {{char}}', char: 'Mira' })
      ).toBe('Prefix. Hello Mira')
    })

    it('stays literal when no original is provided (unknown passthrough)', () => {
      expect(expandMacros('{{original}}', { user: 'A' })).toBe('{{original}}')
    })
  })
})
