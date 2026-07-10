import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { buildCsp } from '../src/renderer/src/plugin/csp'

describe('inline-iframe CSP', () => {
  it('allows rptasset: images in the locked (no-remote) policy', () => {
    const csp = buildCsp(false)
    expect(csp).toMatch(/img-src[^;]*\brptasset:/)
  })
  it('still allows rptasset: when remote is enabled', () => {
    expect(buildCsp(true)).toMatch(/img-src[^;]*\brptasset:/)
  })
  it('keeps the locked default-src none / connect-src none policy', () => {
    expect(buildCsp(false)).toContain("default-src 'none'")
    expect(buildCsp(false)).toContain("connect-src 'none'")
  })
})

describe('main-window CSP (index.html)', () => {
  // The Asset Manager view and the inline card srcdoc frame (which INHERITS this policy) render
  // <img src="rptasset://…">. If img-src omits rptasset:, those images are blocked → broken-image
  // icons. This pins the top-frame allow so a future CSP edit can't silently reintroduce the bug.
  const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf-8')
  const csp = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/)?.[1] ?? ''

  it('has a parseable CSP meta with an img-src directive', () => {
    expect(csp).toMatch(/img-src[^;]+/)
  })
  it('allows rptasset: images (World-Asset portraits in the top frame + inline cards)', () => {
    expect(csp).toMatch(/img-src[^;]*\brptasset:/)
  })
})

describe('WCV card-surface CSP (CARD_CSP)', () => {
  // The PARTNER overlay / STAGE WCV surfaces render <img src="rptasset://…">. CSP `*` does NOT match
  // custom schemes, so img-src must list rptasset: explicitly or the portraits are blocked (broken-image
  // icons). This pins the WCV policy so a future edit can't silently drop it. Read as text (not imported)
  // because wcvManager pulls in electron. WcvMessageFrame / CardScriptWcvHost mirror this string.
  const cardCsp = readFileSync(resolve(__dirname, '../src/main/services/wcvManager.ts'), 'utf-8')

  it('allows rptasset: images in img-src', () => {
    expect(cardCsp).toMatch(/img-src[^;']*\brptasset:/)
  })
  it('allows rptasset: media in media-src (audio/video parity)', () => {
    expect(cardCsp).toMatch(/media-src[^;']*\brptasset:/)
  })
})
