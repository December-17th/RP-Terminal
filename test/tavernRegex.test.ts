import { describe, it, expect } from 'vitest'
import {
  buildFindRegex,
  parseFindRegex,
  storeRuleToTavernRegex,
  tavernRegexToStoreObject
} from '../src/shared/thRuntime/tavernRegex'
import type { RenderRegexRule } from '../src/shared/regexTypes'

const rule = (over: Partial<RenderRegexRule> = {}): RenderRegexRule => ({
  id: 'r1',
  scriptName: '状态栏美化',
  source: '<status>(.*?)</status>',
  flags: 'gs',
  replace: '$1',
  placement: [2],
  trimStrings: ['\\n'],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  ...over
})

describe('parse/build find_regex', () => {
  it('builds /source/flags and parses it back', () => {
    expect(buildFindRegex('a.b', 'gi')).toBe('/a.b/gi')
    expect(parseFindRegex('/a.b/gi')).toEqual({ source: 'a.b', flags: 'gi' })
  })
  it('defaults a bare pattern to flag g', () => {
    expect(parseFindRegex('plain')).toEqual({ source: 'plain', flags: 'g' })
  })
})

describe('storeRuleToTavernRegex', () => {
  it('maps placement → source, markdownOnly → destination, disabled → enabled', () => {
    const tr = storeRuleToTavernRegex(rule())
    expect(tr.id).toBe('r1')
    expect(tr.script_name).toBe('状态栏美化')
    expect(tr.enabled).toBe(true)
    expect(tr.find_regex).toBe('/<status>(.*?)</status>/gs')
    expect(tr.replace_string).toBe('$1')
    expect(tr.trim_strings).toEqual(['\\n'])
    expect(tr.source).toEqual({
      user_input: false,
      ai_output: true,
      slash_command: false,
      world_info: false
    })
    // markdownOnly (display-only) ⇒ display true, prompt false
    expect(tr.destination).toEqual({ display: true, prompt: false })
  })

  it('empty placement applies to both user_input and ai_output', () => {
    const tr = storeRuleToTavernRegex(rule({ placement: [] }))
    expect(tr.source.user_input).toBe(true)
    expect(tr.source.ai_output).toBe(true)
  })

  it('promptOnly ⇒ prompt-only destination; a disabled rule ⇒ enabled:false', () => {
    const tr = storeRuleToTavernRegex(
      rule({ markdownOnly: false, promptOnly: true, disabled: true })
    )
    expect(tr.destination).toEqual({ display: false, prompt: true })
    expect(tr.enabled).toBe(false)
  })
})

describe('tavernRegexToStoreObject', () => {
  it('maps source → placement, destination → markdown/promptOnly, enabled → disabled', () => {
    const obj = tavernRegexToStoreObject(storeRuleToTavernRegex(rule()))
    expect(obj.scriptName).toBe('状态栏美化')
    expect(obj.findRegex).toBe('/<status>(.*?)</status>/gs')
    expect(obj.replaceString).toBe('$1')
    expect(obj.trimStrings).toEqual(['\\n'])
    expect(obj.placement).toEqual([2])
    expect(obj.disabled).toBe(false)
    expect(obj.markdownOnly).toBe(true)
    expect(obj.promptOnly).toBe(false)
  })

  it('defaults a card-built regex (missing fields) to sane values', () => {
    const obj = tavernRegexToStoreObject({ find_regex: '/x/g', replace_string: 'y' })
    expect(obj.scriptName).toBe('Imported regex')
    expect(obj.findRegex).toBe('/x/g')
    expect(obj.placement).toEqual([1, 2]) // no source flags ⇒ applies everywhere
    expect(obj.disabled).toBe(false) // enabled defaults truthy
    expect(obj.markdownOnly).toBe(false)
    expect(obj.promptOnly).toBe(false)
  })
})

describe('round-trip preserves the key fields', () => {
  it('store → TavernRegex → store keeps find/replace/placement/scriptName/enabled', () => {
    const original = rule({ placement: [1, 2], markdownOnly: false, promptOnly: false })
    const back = tavernRegexToStoreObject(storeRuleToTavernRegex(original))
    expect(back.findRegex).toBe(buildFindRegex(original.source, original.flags))
    expect(back.replaceString).toBe(original.replace)
    expect(back.scriptName).toBe(original.scriptName)
    expect(back.placement).toEqual([1, 2])
    expect(back.disabled).toBe(false)
  })
})
