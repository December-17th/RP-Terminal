import { describe, it, expect } from 'vitest'
import {
  extractStyleBlocks,
  scopeCss,
  scopeClassFor
} from '../src/renderer/src/components/messageHtmlScope'

describe('messageHtmlScope — extractStyleBlocks', () => {
  it('pulls every <style> block out and returns the style-free html + concatenated css', () => {
    const { html, css } = extractStyleBlocks('<div>a</div><style>.x{color:red}</style><p>b</p>')
    expect(html).toBe('<div>a</div><p>b</p>')
    expect(css).toContain('.x{color:red}')
  })

  it('handles multiple style blocks', () => {
    const { css } = extractStyleBlocks('<style>.a{}</style><div></div><style>.b{}</style>')
    expect(css).toContain('.a{}')
    expect(css).toContain('.b{}')
  })
})

describe('messageHtmlScope — scopeClassFor', () => {
  it('produces a valid, unique-ish class from a useId value', () => {
    expect(scopeClassFor(':r3:')).toBe('rpt-ih-r3')
    expect(scopeClassFor('')).toBe('rpt-ih-0')
  })
})

describe('messageHtmlScope — scopeCss', () => {
  const S = 'rpt-ih-1'

  it('prefixes every selector with the scope class', () => {
    const out = scopeCss('.card { color: red } .card .title { font-weight: 700 }', S)
    expect(out).toContain(`.${S} .card`)
    expect(out).toContain(`.${S} .card .title`)
  })

  it('scopes each selector in a comma list', () => {
    const out = scopeCss('.a, .b { color: red }', S)
    expect(out).toContain(`.${S} .a`)
    expect(out).toContain(`.${S} .b`)
  })

  it('maps :root/html/body onto the scope element itself (so card custom props apply)', () => {
    const out = scopeCss(':root { --gold: #c5a059 } body { margin: 0 }', S)
    expect(out).toContain(`.${S} {`)
    expect(out).not.toMatch(/:root|\bbody\b/)
  })

  it('scopes rules inside @media but not the @media itself', () => {
    const out = scopeCss('@media (max-width: 600px) { .x { display: none } }', S)
    expect(out).toContain('@media (max-width: 600px)')
    expect(out).toContain(`.${S} .x`)
  })

  it('drops @import (no external stylesheet fetches)', () => {
    const out = scopeCss("@import url('https://fonts.example/x.css'); .x { color: red }", S)
    expect(out).not.toContain('@import')
    expect(out).toContain(`.${S} .x`)
  })

  it('leaves @keyframes step selectors (0%/from/to) untouched', () => {
    const out = scopeCss('@keyframes spin { from { opacity: 0 } to { opacity: 1 } }', S)
    expect(out).toContain('@keyframes spin')
    expect(out).not.toContain(`.${S} from`)
    expect(out).not.toContain(`.${S} to`)
    expect(out).toMatch(/from\s*{/)
  })

  it('returns "" for unparseable css rather than throwing', () => {
    expect(scopeCss('{{{ not css', S)).toBe('')
  })
})
