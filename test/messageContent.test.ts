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

  it('detects a bare <html> document block', () => {
    const segs = splitHtml('<html><body><p>hi</p></body></html>')
    expect(segs.some((s) => s.type === 'html')).toBe(true)
  })

  it('leaves plain prose as a single markdown segment', () => {
    const segs = splitHtml('just some text with no html')
    expect(segs).toEqual([{ type: 'md', text: 'just some text with no html' }])
  })
})
