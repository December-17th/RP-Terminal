import { describe, it, expect } from 'vitest'
import { buildCardDoc } from '../src/renderer/src/components/cardDoc'

describe('buildCardDoc', () => {
  it('injects headInject at the start of an existing <head>, preserving styles/links', () => {
    const html =
      '<!doctype html><html><head><style>.x{color:red}</style><link rel="stylesheet" href="a.css"></head><body><div id="app"></div></body></html>'
    const out = buildCardDoc(html, { headInject: '<!--MARK-->' })
    expect(out).toContain('<head><!--MARK--><style>.x{color:red}</style>')
    expect(out).toContain('<link rel="stylesheet" href="a.css">')
    expect(out).toContain('<div id="app"></div>')
  })

  it('keeps <head> attributes', () => {
    const out = buildCardDoc('<html><head lang="en"></head><body>x</body></html>', {
      headInject: '<!--M-->'
    })
    expect(out).toContain('<head lang="en"><!--M-->')
  })

  it('wraps a bare fragment, using headInject as the head', () => {
    const out = buildCardDoc('<div>hi</div>', { headInject: '<!--M-->' })
    expect(out).toContain('<head><!--M--></head>')
    expect(out).toContain('<body><div>hi</div></body>')
  })

  it('takes <body> inner when given a bare body', () => {
    const out = buildCardDoc('<body class="c"><p>x</p></body>', { headInject: '' })
    expect(out).toContain('<body><p>x</p></body>')
  })

  it('defaults headInject to empty string', () => {
    const out = buildCardDoc('<html><head></head><body>z</body></html>')
    expect(out).toContain('<head></head>')
  })
})
