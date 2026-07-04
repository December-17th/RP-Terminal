import { describe, it, expect } from 'vitest'
import { splitHtml } from '../src/renderer/src/components/MessageContent'
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

  it('does NOT lift body state tags (<tp>/<gametxt>/<UpdateVariable>) into HTML', () => {
    const segs = splitHtml('<tp>day-1</tp><gametxt>rain</gametxt>')
    expect(segs.every((s) => s.type === 'md')).toBe(true)
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
