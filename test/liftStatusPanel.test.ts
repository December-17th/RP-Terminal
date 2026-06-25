import { describe, it, expect } from 'vitest'
import { liftStatusPanel } from '../src/main/services/characterService'

const STATUS = '/dist/status/index.html'
const URL = 'https://testingcf.jsdelivr.net/gh/x/FrontEnd@1.8.2/dist/status/index.html'

const regex = (name: string, repl: string): any => ({ scriptName: name, replaceString: repl })

describe('liftStatusPanel', () => {
  it('lifts the status-loader regex into a panel_ui wcv slot and removes it from the regex list', () => {
    const { panelUi, regexes } = liftStatusPanel([
      regex('状态栏', `<body><script>$('body').load('${URL}')</script></body>`),
      regex('首页', "$('body').load('https://x/dist/home/index.html')"),
      regex('自定义开局', "$('body').load('https://x/dist/custom_start/index.html')")
    ])
    expect(panelUi).toBeTruthy()
    expect(panelUi.mode).toBe('static')
    const slots = panelUi.slots
    expect(slots.map((s: any) => s.view)).toEqual(['chat', 'wcv'])
    const status = slots.find((s: any) => s.view === 'wcv')
    expect(status.entry).toBe(URL)
    expect(status.title).toBe('状态栏')
    expect(status.rect).toEqual([8, 0, 4, 12])
    // the status regex is removed; home + custom_start stay (inline onboarding)
    expect(regexes.map((r: any) => r.scriptName)).toEqual(['首页', '自定义开局'])
  })

  it('leaves cards with no status loader untouched (panelUi null, same regexes)', () => {
    const input = [regex('beautify', 'plain replacement'), regex('首页', `load('${STATUS.replace('status', 'home')}')`)]
    const { panelUi, regexes } = liftStatusPanel(input)
    expect(panelUi).toBeNull()
    expect(regexes).toBe(input)
  })

  it('only lifts the FIRST status loader (a second stays as a regex)', () => {
    const { panelUi, regexes } = liftStatusPanel([
      regex('状态栏', `load('${URL}')`),
      regex('状态栏2', `load('${URL}')`)
    ])
    expect(panelUi).toBeTruthy()
    expect(regexes.map((r: any) => r.scriptName)).toEqual(['状态栏2'])
  })

  it('handles empty / non-array input', () => {
    expect(liftStatusPanel([]).panelUi).toBeNull()
    expect(liftStatusPanel(undefined as any).panelUi).toBeNull()
  })
})
