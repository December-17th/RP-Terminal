import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyRegexRules, loadRegexRules, StRegexRule } from '../src/main/parsers/stRegexEngine'

const rule = (over: Partial<StRegexRule>): StRegexRule => ({
  id: 'r',
  regex: /x/g,
  replaceString: '',
  placement: ['text'],
  disabled: false,
  markdownOnly: false,
  promptOnly: false,
  runOnEdit: false,
  ...over
})

describe('applyRegexRules', () => {
  it('replaces all matches for an enabled rule on the target placement', () => {
    const out = applyRegexRules('foo foo', [rule({ regex: /foo/g, replaceString: 'bar' })])
    expect(out).toBe('bar bar')
  })

  it('skips disabled rules and rules for a different placement', () => {
    expect(applyRegexRules('foo', [rule({ regex: /foo/g, replaceString: 'x', disabled: true })])).toBe('foo')
    expect(
      applyRegexRules('foo', [rule({ regex: /foo/g, replaceString: 'x', placement: ['ai_output'] })])
    ).toBe('foo')
  })

  it('converts the literal \\n escape in replacements to a real newline', () => {
    const out = applyRegexRules('A B', [rule({ regex: / /g, replaceString: '\\n' })])
    expect(out).toBe('A\nB')
  })

  it('applies rules in order', () => {
    const out = applyRegexRules('cat', [
      rule({ regex: /cat/g, replaceString: 'dog' }),
      rule({ regex: /dog/g, replaceString: 'fox' })
    ])
    expect(out).toBe('fox')
  })
})

describe('loadRegexRules', () => {
  const tmp: string[] = []
  afterEach(() => {
    while (tmp.length) fs.rmSync(tmp.pop()!, { force: true })
  })
  const writeRules = (data: unknown): string => {
    const p = path.join(os.tmpdir(), `rpt-rx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(p, JSON.stringify(data))
    tmp.push(p)
    return p
  }

  it('compiles rules and normalizes fields/defaults', () => {
    const file = writeRules([
      { name: 'r1', regex: 'foo', flags: 'gi', replaceString: 'bar', placement: 1, disabled: false }
    ])
    const rules = loadRegexRules(file)
    expect(rules).toHaveLength(1)
    expect(rules[0].regex).toBeInstanceOf(RegExp)
    expect(rules[0].regex.flags).toBe('gi')
    expect(rules[0].placement).toEqual([1])
    expect(rules[0].replaceString).toBe('bar')
    expect(rules[0].markdownOnly).toBe(false)
  })

  it('returns [] for a missing file', () => {
    expect(loadRegexRules(path.join(os.tmpdir(), 'nope.json'))).toEqual([])
  })
})
