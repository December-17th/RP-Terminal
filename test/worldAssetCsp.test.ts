import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { buildCsp } from '../src/renderer/src/plugin/csp'
import { CARD_CSP } from '../src/shared/cardCsp'

describe('inline-iframe CSP', () => {
  it('allows rptasset: images in the locked (no-remote) policy', () => {
    const csp = buildCsp(false)
    expect(csp).toMatch(/img-src[^;]*\brptasset:/)
  })
  it('still allows rptasset: when remote is enabled', () => {
    expect(buildCsp(true)).toMatch(/img-src[^;]*\brptasset:/)
  })
  it('allows on-demand remote images and media without granting direct connect access', () => {
    const csp = buildCsp(false)
    expect(csp).toMatch(/img-src[^;]*\brptremoteasset:/)
    expect(csp).toMatch(/media-src[^;]*\brptremoteasset:/)
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
  it('allows rptremoteasset: for image and video previews', () => {
    expect(csp).toMatch(/img-src[^;]*\brptremoteasset:/)
    expect(csp).toMatch(/media-src[^;]*\brptremoteasset:/)
  })
})

describe('WCV card-surface CSP (CARD_CSP)', () => {
  // The PARTNER overlay / STAGE WCV surfaces render <img src="rptasset://…">. CSP `*` does NOT match
  // custom schemes, so img-src must list rptasset: explicitly or the portraits are blocked (broken-image
  // icons). This pins the WCV policy so a future edit can't silently drop it. Imported directly now that
  // CARD_CSP lives in the electron-free `shared/cardCsp` module (the single source of truth that
  // wcvManager / WcvMessageFrame / CardScriptWcvHost all import).
  it('allows rptasset: images in img-src', () => {
    expect(CARD_CSP).toMatch(/img-src[^;']*\brptasset:/)
  })
  it('allows rptasset: media in media-src (audio/video parity)', () => {
    expect(CARD_CSP).toMatch(/media-src[^;']*\brptasset:/)
  })
  it('allows rptremoteasset: in both visual directives', () => {
    expect(CARD_CSP).toMatch(/img-src[^;']*\brptremoteasset:/)
    expect(CARD_CSP).toMatch(/media-src[^;']*\brptremoteasset:/)
  })
})
