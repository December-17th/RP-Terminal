import { describe, it, expect, beforeEach } from 'vitest'
import {
  plotPanelSettingEnabled,
  plotPanelVisible,
  extractPlotCard,
  plotBlockIsCard,
  plotPanelContent
} from '../src/renderer/src/components/plotPanelVisible'
import { splitHtml } from '../src/renderer/src/components/MessageContent'
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

describe('extractPlotCard / plotPanelContent (robust card recovery)', () => {
  const CARD = '<!DOCTYPE html>\n<html><head><style>#t{display:none}</style></head><body>' +
    '<textarea id="t">plot data</textarea><div id="app"><script>renderPanel()</script>PANEL</div></body></html>'

  it('extracts a well-formed ```html card', () => {
    expect(extractPlotCard('```html\n' + CARD + '\n```')).toContain('<div id="app">')
  })

  it('recovers the card when the closing fence is broken/absent (the raw-code failure mode)', () => {
    // No trailing ``` — MessageContent lazy-matching would miss/mangle it; extraction still recovers it.
    const card = extractPlotCard('```html\n' + CARD + '\nOOPS trailing junk with no closing fence')
    expect(card).toContain('<div id="app">')
    expect(card).toContain('</html>')
    expect(card).not.toContain('OOPS') // stops at </html>, drops trailing junk
  })

  it('recovers a bare document when the ```html fence is gone entirely', () => {
    expect(extractPlotCard(CARD)).toContain('<div id="app">')
    expect(extractPlotCard('<html><body><b>x</b></body></html>')).toBe('<html><body><b>x</b></body></html>')
  })

  it('returns null when there is no HTML document (beautifier did not run — raw prose)', () => {
    expect(extractPlotCard('<用户本轮输入>\ngo north\n</用户本轮输入>\n<QuestPlan>plan</QuestPlan>')).toBeNull()
  })

  it('plotPanelContent re-wraps a recovered card as a PRISTINE ```html block splitHtml extracts as ONE frame', () => {
    // A card wrapped in a fence with trailing junk — the shape that left the plot panel showing raw code.
    const beautified = '```html\n' + CARD + '\n```\nleftover'
    const content = plotPanelContent(beautified)
    const segs = splitHtml(content)
    const htmls = segs.filter((s) => s.type === 'html')
    expect(htmls).toHaveLength(1)
    expect(htmls[0].text).toContain('<div id="app">')
    // Nothing leaks out as a raw markdown/code segment.
    expect(segs.some((s) => s.type !== 'html' && s.text.includes('PANEL'))).toBe(false)
  })

  it('forces ONE frame when the document is shredded but the card <script> survives (the raw-code case)', () => {
    // The observed failure: no clean <html>…</html> (structure broken so extractPlotCard + the splitter
    // both miss it), but the card's own <script> is present — so it must still render as a frame, not the
    // indented code block the user saw. No closing </body>/</html> anywhere.
    const shredded =
      '```html\n<head><style>.x{color:red}</style></head><body><div id="app">' +
      '<script>const parts = unfilteredRaw.split(regex); renderPanel()</script>PANEL</div>'
    expect(extractPlotCard(shredded)).toBeNull()
    expect(plotBlockIsCard(shredded)).toBe(true)
    const segs = splitHtml(plotPanelContent(shredded))
    const htmls = segs.filter((s) => s.type === 'html')
    expect(htmls).toHaveLength(1) // one frame — NOT raw markdown/code
    expect(htmls[0].text).toContain('renderPanel()')
    expect(segs.some((s) => s.type !== 'html' && s.text.includes('unfilteredRaw'))).toBe(false)
  })

  it('plotPanelContent passes raw prose through unchanged (no false card wrapping)', () => {
    const raw = '<用户本轮输入>\ngo north\n</用户本轮输入>'
    expect(plotBlockIsCard(raw)).toBe(false)
    expect(plotPanelContent(raw)).toBe(raw)
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
