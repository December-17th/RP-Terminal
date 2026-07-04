import { afterAll, describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  applyRegex,
  getPromptRules,
  getRenderRules,
  saveRegexScript
} from '../src/main/services/regexService'
import type { RenderRegexRule } from '../src/main/services/regexService'
import { getAppDir } from '../src/main/services/storageService'

const rule = (over: Partial<RenderRegexRule>): RenderRegexRule => ({
  id: 'r',
  scriptName: 's',
  source: 'x',
  flags: 'g',
  replace: '',
  placement: [],
  disabled: false,
  markdownOnly: false,
  promptOnly: false,
  trimStrings: [],
  ...over
})

describe('applyRegex (prompt-time)', () => {
  it('only applies to a matching placement; empty placement applies everywhere', () => {
    const r = rule({ source: 'a', replace: 'A', placement: [1] })
    expect(applyRegex('a', [r], 1)).toBe('A')
    expect(applyRegex('a', [r], 2)).toBe('a')
    expect(applyRegex('a', [rule({ source: 'a', replace: 'A', placement: [] })], 2)).toBe('A')
  })

  it('supports {{match}}+trimStrings, capture groups, and {{user}}/{{char}}', () => {
    expect(
      applyRegex(
        '**b**',
        [rule({ source: '\\*\\*[^*]+\\*\\*', replace: '<b>{{match}}</b>', trimStrings: ['**'] })],
        1
      )
    ).toBe('<b>b</b>')
    expect(applyRegex('a@b', [rule({ source: '(\\w+)@(\\w+)', replace: '$2.$1' })], 1)).toBe('b.a')
    expect(
      applyRegex('NAME', [rule({ source: 'NAME', replace: '{{user}}' })], 1, { user: 'Lyra' })
    ).toBe('Lyra')
  })

  it('skips a rule with an invalid pattern instead of throwing', () => {
    expect(applyRegex('keep', [rule({ source: '(', replace: 'X' })], 1)).toBe('keep')
  })
})

describe('regex destination flags', () => {
  const profileId = `test-${randomUUID()}`
  const profileDir = path.join(getAppDir(), 'profiles', profileId)
  afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

  it('treats markdownOnly+promptOnly as both display and prompt destinations', () => {
    saveRegexScript(profileId, {
      scriptName: 'cleanup',
      findRegex: '/<!--[\\s\\S]*?-->/g',
      replaceString: '',
      placement: [2],
      markdownOnly: true,
      promptOnly: true
    })

    const renderRules = getRenderRules(profileId)
    const promptRules = getPromptRules(profileId)

    expect(renderRules).toHaveLength(1)
    expect(promptRules).toHaveLength(1)
    expect(applyRegex('A<!-- itemThink:\nplan\n-->B', renderRules, 2)).toBe('AB')
  })
})
