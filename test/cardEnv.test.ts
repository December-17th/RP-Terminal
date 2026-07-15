import { describe, it, expect } from 'vitest'
import { buildEnvHead, replaceVhInContent, BASE_RESET_CSS } from '../src/shared/cardEnv'

describe('replaceVhInContent', () => {
  it('rewrites a CSS-block min-height:100vh to the viewport variable', () => {
    expect(replaceVhInContent('.a{min-height:100vh}')).toBe(
      '.a{min-height:var(--TH-viewport-height)}'
    )
  })

  it('rewrites a non-100 CSS min-height to a calc fraction (and keeps the terminator)', () => {
    expect(replaceVhInContent('.a{min-height: 50vh;}')).toBe(
      '.a{min-height: calc(var(--TH-viewport-height) * 0.5);}'
    )
  })

  it('rewrites min-height inside an inline style attribute', () => {
    expect(replaceVhInContent('<div style="min-height:100vh">')).toBe(
      '<div style="min-height:var(--TH-viewport-height)">'
    )
  })

  it('rewrites JS element.style.minHeight assignment', () => {
    expect(replaceVhInContent('el.style.minHeight = "100vh"')).toBe(
      'el.style.minHeight = "var(--TH-viewport-height)"'
    )
  })

  it('rewrites JS setProperty(min-height, …vh)', () => {
    expect(replaceVhInContent("el.style.setProperty('min-height', '50vh')")).toBe(
      "el.style.setProperty('min-height', 'calc(var(--TH-viewport-height) * 0.5)')"
    )
  })

  it('leaves a bare height:100vh untouched (only min-height is rewritten)', () => {
    expect(replaceVhInContent('.a{height:100vh}')).toBe('.a{height:100vh}')
  })

  it('is a no-op when there is no vh', () => {
    const css = '.a{color:red;min-height:40px}'
    expect(replaceVhInContent(css)).toBe(css)
  })

  it('does not double-convert an inline style ending in a semicolon', () => {
    expect(replaceVhInContent('<div style="min-height:100vh;">')).toBe(
      '<div style="min-height:var(--TH-viewport-height);">'
    )
  })
})

describe('buildEnvHead', () => {
  const opts = {
    libTags: '<script src="/vue.js"></script>',
    sizing: 'fit' as const,
    viewportHeightPx: 800
  }

  it('includes the base reset', () => {
    expect(buildEnvHead(opts)).toContain(BASE_RESET_CSS)
  })

  it('defines the Vue production devtools flag before card libraries execute', () => {
    const head = buildEnvHead(opts)
    const flagPos = head.indexOf('var __VUE_PROD_DEVTOOLS__=false;')
    const libPos = head.indexOf(opts.libTags)
    expect(flagPos).toBeGreaterThanOrEqual(0)
    expect(flagPos).toBeLessThan(libPos)
  })

  it('orders style → libs → viewport bootstrap', () => {
    const head = buildEnvHead(opts)
    const stylePos = head.indexOf('<style>')
    const libPos = head.indexOf(opts.libTags)
    const vpPos = head.indexOf('--TH-viewport-height')
    expect(stylePos).toBeLessThan(libPos)
    expect(libPos).toBeLessThan(vpPos)
  })

  it('emits avatar rules when URLs are provided', () => {
    const head = buildEnvHead({ ...opts, userAvatarUrl: '/u.png', charAvatarUrl: '/c.png' })
    expect(head).toContain(".user_avatar,.user-avatar{background-image:url('/u.png')}")
    expect(head).toContain(".char_avatar,.char-avatar{background-image:url('/c.png')}")
  })

  it('omits an avatar rule whose URL is empty', () => {
    const head = buildEnvHead({ ...opts, charAvatarUrl: '/c.png' })
    expect(head).not.toContain('.user_avatar')
    expect(head).toContain('.char_avatar')
  })

  it('escapes a single quote in an avatar URL so it cannot break out of url()', () => {
    const head = buildEnvHead({ ...opts, charAvatarUrl: "/a'b.png" })
    expect(head).toContain("url('/a\\'b.png')")
  })

  it('seeds an explicit viewport height', () => {
    expect(buildEnvHead(opts)).toContain('var h=800;')
  })

  it('falls back to window.innerHeight when no viewport height is given', () => {
    const head = buildEnvHead({ libTags: '', sizing: 'fit' })
    expect(head).toContain('var h=window.innerHeight;')
  })

  it('keeps overflow:hidden by default, but overrides to auto when scrollable (WCV)', () => {
    expect(buildEnvHead(opts)).not.toContain('overflow:auto')
    expect(buildEnvHead({ ...opts, scrollable: true })).toContain(
      'html,body{overflow:auto!important}'
    )
  })
})
