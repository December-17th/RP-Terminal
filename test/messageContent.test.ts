import { describe, it, expect } from 'vitest'
import { splitHtml, stripUnknownHtmlTags } from '../src/renderer/src/components/MessageContent'
import { isInteractiveHtml } from '../src/renderer/src/plugin/bridgeShim'

describe('splitHtml (HTML block detection)', () => {
  it('detects a ```html fenced block', () => {
    const segs = splitHtml('before\n```html\n<div>x</div>\n```\nafter')
    expect(segs.map((s) => s.type)).toEqual(['md', 'html', 'md'])
    expect(segs[1].text).toContain('<div>x</div>')
  })

  it('detects a bare <body> frontend-card block (no code fence)', () => {
    const card = '<body>\n<script>\n$("body").load("https://cdn/x.html")\n</script>\n</body>'
    const segs = splitHtml(`narration text\n${card}`)
    const html = segs.find((s) => s.type === 'html')
    expect(html).toBeTruthy()
    expect(html!.text).toContain('<script>')
    // …and it routes to the interactive (scripted) frame.
    expect(isInteractiveHtml(html!.text)).toBe(true)
  })

  it('detects a plain fenced full HTML card as one block', () => {
    const card =
      '<!DOCTYPE html>\n<html><body><script>renderPanel(`$0`)</script></body></html>'
    const segs = splitHtml(`before\n\`\`\`\n${card}\n\`\`\`\nafter`)
    expect(segs.map((s) => s.type)).toEqual(['md', 'html', 'md'])
    expect(segs[1].text).toBe(card)
    expect(segs.some((s) => s.text.includes('```'))).toBe(false)
    expect(isInteractiveHtml(segs[1].text)).toBe(true)
  })

  it('detects a bare <html> document block', () => {
    const segs = splitHtml('<html><body><p>hi</p></body></html>')
    expect(segs.some((s) => s.type === 'html')).toBe(true)
  })

  it('keeps a ```html full document intact when its body carries an inner ``` fence (plot-panel regression)', () => {
    // The plot beautifier wraps the turn input — which frequently carries a ```text fence — in a
    // <textarea> inside a full ```html document. A lazy fence close would end the outer block at that
    // INNER ```, slicing the 命定之诗 plot card in half (the "full-screen black scene" bug): the head-only
    // fragment paints an empty dark frame and ~100KB of card body leaks out below as markdown.
    const card =
      '<!DOCTYPE html>\n<html><head><style>#t{display:none}</style></head><body>' +
      '<textarea id="t">&lt;用户本轮输入&gt;\n```text\n【角色信息】\n```\n&lt;/用户本轮输入&gt;</textarea>' +
      '<div id="app">PANEL</div></body></html>'
    const segs = splitHtml('```html\n' + card + '\n```')
    const htmls = segs.filter((s) => s.type === 'html')
    expect(htmls).toHaveLength(1) // ONE intact card, not truncated at the inner ```
    expect(htmls[0].text).toContain('<div id="app">PANEL</div>') // the tail survived
    expect(htmls[0].text).toContain('```text') // the inner fence is preserved inside the card
    // No slice of the card body leaked out as a separate md / inline segment.
    expect(segs.some((s) => s.type !== 'html' && s.text.includes('PANEL'))).toBe(false)
  })

  it('leaves plain prose as a single markdown segment', () => {
    const segs = splitHtml('just some text with no html')
    expect(segs).toEqual([{ type: 'md', text: 'just some text with no html' }])
  })

  it('renders a bare <div> card inline (no fence, no <body>) and keeps nested divs whole', () => {
    const card = '<div class="card"><h3>Sword</h3><div class="row">atk: 6</div></div>'
    const segs = splitHtml(`You find it:\n${card}\nWhat now?`)
    expect(segs.map((s) => s.type)).toEqual(['md', 'inline-html', 'md'])
    expect(segs[1].text).toBe(card) // full outer div incl. the nested one, not truncated early
    expect(segs[2].text).toContain('What now?')
  })

  it('renders a scripted bare block inline (the <script> is stripped, never auto-run in a frame)', () => {
    const segs = splitHtml('<div><script>alert(1)</script></div>')
    expect(segs).toHaveLength(1)
    // Bare regions never auto-execute: DOMPurify strips the <script> at render. Authored frontend
    // cards opt into the scripted frame via a ```html fence / <body> (the HTML_BLOCK path).
    expect(segs[0].type).toBe('inline-html')
  })

  it('keeps a card and its SIBLING <style> sheet together as ONE inline region', () => {
    const card = '<div class="c"><span>hi</span></div><style>.c{color:red}</style>'
    const segs = splitHtml(card)
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('inline-html') // <style> renders inline (scoped), no longer a frame
    expect(segs[0].text).toContain('<div class="c">')
    expect(segs[0].text).toContain('<style>.c{color:red}</style>') // sheet absorbed into the region
  })

  it('groups a leading <style> + following card into one inline region', () => {
    const segs = splitHtml('<style>.c{color:red}</style>\n<div class="c">x</div>')
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('inline-html')
    expect(segs[0].text).toContain('<div class="c">x</div>')
  })

  it('still renders an inline-styled card (no <style> tag) inline', () => {
    const segs = splitHtml('<div style="color:red"><b>x</b></div>')
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('inline-html')
  })

  it('renders top-level styled span/ruby markup inline instead of markdown-escaping it', () => {
    const card =
      '<span style="font-size:2.0em;color:#00FF00;text-shadow:0 0 8px #00FF00;"><ruby>ꡁꡏꡙꡚ<rt>强酸喷吐</rt></ruby></span>'
    const segs = splitHtml(card)
    expect(segs).toEqual([{ type: 'inline-html', text: card }])
  })

  it('lifts a styled <span> standing alone on its own line, keeping surrounding prose markdown', () => {
    const card = '<span style="color:#00FF00"><ruby>ꡁꡏ<rt>强酸</rt></ruby></span>'
    const segs = splitHtml(`咏唱开始：\n${card}\n酸液喷涌而出。`)
    expect(segs.map((s) => s.type)).toEqual(['md', 'inline-html', 'md'])
    expect(segs[1].text).toBe(card)
  })

  it('keeps a mid-sentence styled <span> as markdown (never splits the paragraph)', () => {
    const md = '他低声吟唱：<span style="color:red">火球术</span>，火焰腾起。'
    expect(splitHtml(md)).toEqual([{ type: 'md', text: md }])
  })

  it('keeps a styled <span> inside a GFM list item as markdown (list stays whole)', () => {
    const md = '- 攻击：<span style="color:red">火球</span>\n- 防御：高'
    expect(splitHtml(md)).toEqual([{ type: 'md', text: md }])
  })

  it('does not treat a lone <rt> outside <ruby> as an HTML region', () => {
    const md = 'note <rt>annotation</rt> text'
    expect(splitHtml(md)).toEqual([{ type: 'md', text: md }])
  })

  it('still lifts a structural card after skipping a mid-prose span', () => {
    const segs = splitHtml('说着<span style="color:red">怒</span>：\n<div class="card">x</div>')
    expect(segs.map((s) => s.type)).toEqual(['md', 'inline-html'])
    expect(segs[1].text).toBe('<div class="card">x</div>')
  })

  it('does NOT lift body state tags (<tp>/<gametxt>/<UpdateVariable>) into HTML', () => {
    const segs = splitHtml('<tp>day-1</tp><gametxt>rain</gametxt>')
    expect(segs.every((s) => s.type === 'md')).toBe(true)
    // …and the unhandled custom wrapper tags are dropped so they never render as escaped text —
    // only their content survives.
    expect(segs.map((s) => s.text).join('')).toBe('day-1rain')
  })

  it('strips unhandled custom wrapper tags left in markdown (the <gametxt>/<scene_info> leak)', () => {
    // A card whose display regex handles <tp>/<options> but not <gametxt>/<scene_info>: those two
    // wrappers reach the markdown path. Without rehype-raw react-markdown would escape them into
    // visible "<gametxt>" text; splitHtml now drops the tag tokens, keeping the narration + the
    // lifted scene <div>.
    const src =
      '<gametxt>\n穿过大殿后，是一段漫长的回廊。\n\n<scene_info>\n' +
      '<div style="color:#e0e0e0">皇宫侧殿</div>\n' +
      '</scene_info>\n\n安静的房间里。\n</gametxt>'
    const segs = splitHtml(src)
    // The scene card <div> is lifted to its own inline-html region…
    expect(segs.some((s) => s.type === 'inline-html' && s.text.includes('皇宫侧殿'))).toBe(true)
    // …and NONE of the wrapper tags survive anywhere in the output.
    const all = segs.map((s) => s.text).join('\n')
    for (const t of ['<gametxt>', '</gametxt>', '<scene_info>', '</scene_info>']) {
      expect(all).not.toContain(t)
    }
    // The narration itself is preserved.
    expect(all).toContain('穿过大殿后')
    expect(all).toContain('安静的房间里')
  })

  it('handles two separate bare blocks with prose between them', () => {
    const segs = splitHtml('<div>A</div>mid<section>B</section>')
    expect(segs.map((s) => s.type)).toEqual(['inline-html', 'md', 'inline-html'])
    expect(segs[0].text).toBe('<div>A</div>')
    expect(segs[2].text).toBe('<section>B</section>')
  })

  it('treats an unclosed bare tag as markdown (no false HTML block)', () => {
    const segs = splitHtml('a < b and 2 > 1, plus <div not really closed')
    expect(segs.every((s) => s.type === 'md')).toBe(true)
  })
})

describe('stripUnknownHtmlTags (custom-tag unwrap)', () => {
  it('drops open + close tokens for an unknown tag, keeping children', () => {
    expect(stripUnknownHtmlTags('<gametxt>hello</gametxt>')).toBe('hello')
    expect(stripUnknownHtmlTags('a<scene_info>b</scene_info>c')).toBe('abc')
  })

  it('drops a stray/unbalanced unknown tag too (truncated stream)', () => {
    expect(stripUnknownHtmlTags('text <gametxt> more')).toBe('text  more')
    expect(stripUnknownHtmlTags('</scene_info>')).toBe('')
  })

  it('drops an unknown tag carrying attributes', () => {
    expect(stripUnknownHtmlTags('<status hp="10">x</status>')).toBe('x')
  })

  it('leaves known HTML/SVG/MathML tags untouched', () => {
    expect(stripUnknownHtmlTags('a <span style="color:red">x</span> b')).toBe(
      'a <span style="color:red">x</span> b'
    )
    expect(stripUnknownHtmlTags('<ruby>字<rt>zi</rt></ruby>')).toBe('<ruby>字<rt>zi</rt></ruby>')
    expect(stripUnknownHtmlTags('<sub>2</sub> and <br>')).toBe('<sub>2</sub> and <br>')
  })

  it('never touches comparisons, math, hearts, or autolinks', () => {
    expect(stripUnknownHtmlTags('a < b and 2 > 1')).toBe('a < b and 2 > 1')
    expect(stripUnknownHtmlTags('I <3 it')).toBe('I <3 it')
    expect(stripUnknownHtmlTags('<https://example.com>')).toBe('<https://example.com>')
    expect(stripUnknownHtmlTags('<user@example.com>')).toBe('<user@example.com>')
    // An unterminated tag (no closing `>`) is left as literal text.
    expect(stripUnknownHtmlTags('<div not really closed')).toBe('<div not really closed')
  })

  it('does not strip inside a fenced code block', () => {
    const md = 'before\n```text\n<gametxt>literal</gametxt>\n```\nafter'
    expect(stripUnknownHtmlTags(md)).toBe(md)
  })

  it('does not strip inside an inline code span', () => {
    expect(stripUnknownHtmlTags('use `<gametxt>` here')).toBe('use `<gametxt>` here')
    // …but still strips the same tag OUTSIDE the span.
    expect(stripUnknownHtmlTags('`<gametxt>` then <gametxt>x</gametxt>')).toBe(
      '`<gametxt>` then x'
    )
  })
})
