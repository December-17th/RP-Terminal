import { describe, it, expect } from 'vitest'
import { splitHtml } from '../src/renderer/src/components/MessageContent'

describe('splitHtml mode marker', () => {
  it('attaches isolated mode from a marker before an html block and strips it', () => {
    const segs = splitHtml('intro <!--rpt:mode=isolated--><html><body>c</body></html> after')
    const html = segs.find((s) => s.type === 'html')!
    expect(html.mode).toBe('isolated')
    const md = segs.find((s) => s.type === 'md' && s.text.includes('intro'))!
    expect(md.text).not.toContain('rpt:mode')
    expect(md.text).toContain('intro')
  })
  it('handles inline mode + whitespace/newline between marker and block', () => {
    const segs = splitHtml('<!--rpt:mode=inline-->\n```html\n<div>x</div>\n```')
    expect(segs.find((s) => s.type === 'html')!.mode).toBe('inline')
  })
  it('leaves mode undefined when there is no marker', () => {
    const segs = splitHtml('<html><body>c</body></html>')
    expect(segs.find((s) => s.type === 'html')!.mode).toBeUndefined()
  })
})
