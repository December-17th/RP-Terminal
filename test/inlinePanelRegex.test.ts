import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  saveRegexScript,
  listScripts,
  listPanelRegexes
} from '../src/main/services/regexService'
import { getAppDir } from '../src/main/services/storageService'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('inline-HTML panel regex promotion (PA6app)', () => {
  it('Change 1: saveRegexScript persists renderMode:"panel" from the rule into meta', () => {
    saveRegexScript(
      profileId,
      {
        scriptName: 'PartyPanel',
        findRegex: '<party-panel/>',
        replaceString: '<div>hi</div>',
        renderMode: 'panel'
      },
      'world',
      'card1'
    )
    const scripts = listScripts(profileId)
    const s = scripts.find((x) => x.scriptName === 'PartyPanel')
    expect(s).toBeDefined()
    expect(s!.renderMode).toBe('panel')
  })

  it('Change 2: listPanelRegexes promotes inline-HTML panel with data: url', () => {
    // world scope, owner=card1 → ctx must activate it
    const ctx = { cardId: 'card1' }
    const panels = listPanelRegexes(profileId, ctx)
    const p = panels.find((x) => x.scriptName === 'PartyPanel')
    expect(p).toBeDefined()
    expect(p!.url).toMatch(/^data:text\/html/)
    // The decoded HTML must contain the original replaceString
    const encoded = p!.url.replace(/^data:text\/html;charset=utf-8,/, '')
    expect(decodeURIComponent(encoded)).toContain('<div>hi</div>')
  })

  it('Change 2 regression: loader-form panel still promotes with the remote url', () => {
    saveRegexScript(
      profileId,
      {
        scriptName: 'LoaderPanel',
        findRegex: '<loader/>',
        replaceString: `<script>$('body').load('https://x/y.html')</script>`,
        renderMode: 'panel'
      },
      'world',
      'card1'
    )
    const ctx = { cardId: 'card1' }
    const panels = listPanelRegexes(profileId, ctx)
    const p = panels.find((x) => x.scriptName === 'LoaderPanel')
    expect(p).toBeDefined()
    expect(p!.url).toBe('https://x/y.html')
  })

  it('non-panel scripts are not listed', () => {
    saveRegexScript(
      profileId,
      {
        scriptName: 'PlainReplace',
        findRegex: '<x/>',
        replaceString: 'y'
      },
      'world',
      'card1'
    )
    const ctx = { cardId: 'card1' }
    const panels = listPanelRegexes(profileId, ctx)
    expect(panels.find((x) => x.scriptName === 'PlainReplace')).toBeUndefined()
  })

  it('world-scoped panel is not listed when the wrong card is active', () => {
    const ctx = { cardId: 'wrong-card' }
    const panels = listPanelRegexes(profileId, ctx)
    expect(panels.find((x) => x.scriptName === 'PartyPanel')).toBeUndefined()
  })
})
