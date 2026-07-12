import { describe, it, expect, beforeEach } from 'vitest'
import { plotPanelSettingEnabled, plotPanelVisible } from '../src/renderer/src/components/plotPanelVisible'
import { useRegexStore } from '../src/renderer/src/stores/regexStore'
import type { RenderRegexRule } from '../src/shared/regexTypes'

const rule = (over: Partial<RenderRegexRule>): RenderRegexRule => ({
  id: 'r',
  scriptName: 's',
  source: 'x',
  flags: 'g',
  replace: '',
  placement: [],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  trimStrings: [],
  ...over
})

describe('plot panel visibility gate', () => {
  it('setting defaults ON when the display block (or flag) is absent', () => {
    expect(plotPanelSettingEnabled(undefined)).toBe(true)
    expect(plotPanelSettingEnabled({})).toBe(true)
    expect(plotPanelSettingEnabled({ plotBlock: true })).toBe(true)
    expect(plotPanelSettingEnabled({ plotBlock: false })).toBe(false)
  })

  it('renders only when the setting is ON and a non-empty plot_block is present', () => {
    // present + on ⇒ show
    expect(plotPanelVisible('<QuestPlan>…</QuestPlan>', true)).toBe(true)
    // setting off ⇒ hide even when present
    expect(plotPanelVisible('<QuestPlan>…</QuestPlan>', false)).toBe(false)
    // absent / empty / whitespace ⇒ hide even when on
    expect(plotPanelVisible(undefined, true)).toBe(false)
    expect(plotPanelVisible('', true)).toBe(false)
    expect(plotPanelVisible('   \n ', true)).toBe(false)
  })
})

describe('regexStore.applyPlot (plot_block flows through placement-1 rules)', () => {
  beforeEach(() => {
    useRegexStore.setState({ rules: [], plotRules: [] })
  })

  it('applies the loaded plot rules (placement-1 beautifier) to a plot_block', () => {
    useRegexStore.setState({
      plotRules: [
        rule({
          source: '<用户本轮输入>([\\s\\S]*?)</用户本轮输入>',
          replace: '```html\n<div>$1</div>\n```',
          placement: [1]
        })
      ]
    })
    const out = useRegexStore.getState().applyPlot('<用户本轮输入>go north</用户本轮输入>')
    expect(out).toContain('<div>go north</div>')
  })

  it('is independent of the display rules (`apply` uses `rules`, `applyPlot` uses `plotRules`)', () => {
    useRegexStore.setState({
      rules: [rule({ source: 'A', replace: 'DISPLAY', placement: [2] })],
      plotRules: [rule({ source: 'A', replace: 'PLOT', placement: [1] })]
    })
    expect(useRegexStore.getState().apply('A')).toBe('DISPLAY')
    expect(useRegexStore.getState().applyPlot('A')).toBe('PLOT')
  })
})
