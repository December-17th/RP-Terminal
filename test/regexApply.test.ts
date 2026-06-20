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

const apply = (text: string, rules: RenderRegexRule[], ctx?: { user?: string; char?: string }): string => {
  useRegexStore.setState({ rules })
  return useRegexStore.getState().apply(text, ctx)
}

describe('regexStore.apply', () => {
  it('substitutes capture groups ($1, $2)', () => {
    expect(apply('a@b', [rule({ source: '(\\w+)@(\\w+)', replace: '$2.$1' })])).toBe('b.a')
  })

  it('{{match}} is the matched text with trimStrings removed', () => {
    const r = rule({ source: '\\*\\*[^*]+\\*\\*', replace: '<b>{{match}}</b>', trimStrings: ['**'] })
    expect(apply('hi **bold** there', [r])).toBe('hi <b>bold</b> there')
  })

  it('substitutes {{user}} and {{char}} from the context', () => {
    const r = rule({ source: 'NAME', replace: '{{user}} & {{char}}' })
    expect(apply('NAME', [r], { user: 'Lyra', char: 'Aria' })).toBe('Lyra & Aria')
  })

  it('converts \\n in the replacement to a real newline', () => {
    expect(apply('a|b', [rule({ source: '\\|', replace: '\\n' })])).toBe('a\nb')
  })

  it('applies multiple rules in order', () => {
    const rules = [rule({ source: 'cat', replace: 'dog' }), rule({ source: 'dog', replace: 'fox' })]
    expect(apply('cat', rules)).toBe('fox')
  })
})
