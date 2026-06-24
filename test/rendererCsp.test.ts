import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// The InlineCardFrame renders a trusted card in a SAME-ORIGIN srcdoc iframe that INHERITS this
// document's CSP (a child <meta> can only TIGHTEN an inherited policy, never loosen it). So for inline
// cards to load their own ESM modules / stylesheets / fonts from any CDN — at parity with the Isolated
// (WCV) path's CARD_CSP — the renderer policy must permit `https:` in script/style/font/connect.
// This guards against a future re-tightening silently re-breaking inline card rendering (the
// testingcf.jsdelivr.net `script-src` block this test was written for).
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8')
const csp = html.match(/content="(default-src[^"]*)"/i)?.[1] ?? ''

const sources = (name: string): string[] => {
  const d = csp
    .split(';')
    .map((s) => s.trim())
    .find((d) => d === name || d.startsWith(name + ' '))
  return d ? d.split(/\s+/).slice(1) : []
}

describe('renderer CSP (inline card asset loading)', () => {
  it('declares a Content-Security-Policy', () => {
    expect(csp).not.toBe('')
  })

  // Inline cards inherit this CSP, so these must allow remote https assets (WCV parity).
  for (const directive of ['script-src', 'style-src', 'font-src', 'connect-src']) {
    it(`allows https: in ${directive} so inline cards can load remote assets`, () => {
      expect(sources(directive)).toContain('https:')
    })
  }

  it("keeps 'wasm-unsafe-eval' for the quickjs ST-Prompt-Template engine", () => {
    expect(sources('script-src')).toContain("'wasm-unsafe-eval'")
  })

  it("does NOT grant the broader 'unsafe-eval' (no card has needed JS eval)", () => {
    expect(sources('script-src')).not.toContain("'unsafe-eval'")
  })
})
