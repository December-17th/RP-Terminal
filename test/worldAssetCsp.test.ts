import { describe, it, expect } from 'vitest'
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
