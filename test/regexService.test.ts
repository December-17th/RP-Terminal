import { afterAll, describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  applyRegex,
  getPlotBlockRules,
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

describe('getPlotBlockRules (plot-recall placement-1 selector)', () => {
  const profileId = `test-${randomUUID()}`
  const profileDir = path.join(getAppDir(), 'profiles', profileId)
  afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

  it('includes a placement-1 markdownOnly rule that the display path drops, and excludes disabled/prompt-only', () => {
    // A user-input (placement 1) display beautifier — the shape the plot block carries.
    saveRegexScript(profileId, {
      scriptName: 'plot beautify',
      findRegex: '/<用户本轮输入>([\\s\\S]*?)<\\/用户本轮输入>/g',
      replaceString: '```html\n<div>$1</div>\n```',
      placement: [1],
      markdownOnly: true
    })
    // A normal placement-2 output beautifier — present in both selectors.
    saveRegexScript(profileId, {
      scriptName: 'output beautify',
      findRegex: '/<gametxt>([\\s\\S]*?)<\\/gametxt>/g',
      replaceString: '$1',
      placement: [2],
      markdownOnly: true
    })
    // A prompt-only rule — display selectors must skip it.
    saveRegexScript(profileId, {
      scriptName: 'prompt cleanup',
      findRegex: '/<x>/g',
      replaceString: '',
      placement: [1],
      promptOnly: true
    })

    const plotRules = getPlotBlockRules(profileId)
    const renderRules = getRenderRules(profileId)

    const plotNames = plotRules.map((r) => r.scriptName).sort()
    // Plot selector keeps BOTH display beautifiers (placement 1 and 2), skips the prompt-only rule.
    expect(plotNames).toEqual(['output beautify', 'plot beautify'])
    // The display path drops the placement-1 rule — the whole reason this selector exists.
    expect(renderRules.map((r) => r.scriptName)).toEqual(['output beautify'])
    // And the selected placement-1 rule actually transforms a plot block.
    const plot1 = plotRules.find((r) => r.scriptName === 'plot beautify')!
    expect(applyRegex('<用户本轮输入>go north</用户本轮输入>', [plot1], 1)).toContain(
      '<div>go north</div>'
    )
  })
})
