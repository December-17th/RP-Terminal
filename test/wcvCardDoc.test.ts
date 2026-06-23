import { describe, it, expect } from 'vitest'
import { buildCardDoc } from '../src/renderer/src/components/WcvMessageFrame'

// A SillyTavern beautification card as emitted by the example regex scripts: a full
// `<!doctype html>` document whose <style> and font <link> live in <head>, with the
// content + <script> in <body>. The bug: only the <body> was kept, so the card lost
// ALL its CSS (incl. `html,body{background:transparent}`) and painted as an oversized
// white box of unstyled text over the app UI.
const FULL_CARD = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel" />
  <style>
    html, body { margin: 0; background: transparent; }
    .ticket-box { background: #fbf6ea; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="ticket-box">hello</div>
  <script>console.log('card loaded')</script>
</body>
</html>`

describe('buildCardDoc (WCV card document)', () => {
  it('preserves the <head> CSS and font links of a full-document card', () => {
    const doc = buildCardDoc(FULL_CARD)
    // The card's stylesheet must survive — this is the fix for the white-box bug.
    expect(doc).toContain('html, body { margin: 0; background: transparent; }')
    expect(doc).toContain('.ticket-box { background: #fbf6ea')
    expect(doc).toContain('fonts.googleapis.com')
  })

  it('keeps the body content and its <script> (still an interactive card)', () => {
    const doc = buildCardDoc(FULL_CARD)
    expect(doc).toContain('<div class="ticket-box">hello</div>')
    expect(doc).toContain("console.log('card loaded')")
  })

  it('injects the card CSP <meta> into the document head', () => {
    const doc = buildCardDoc(FULL_CARD)
    expect(doc).toMatch(/http-equiv="Content-Security-Policy"/i)
  })

  it('still wraps a bare loader fragment (no <head>) and injects the CSP', () => {
    const loader = '<body><script>$("body").load("https://cdn/x.html")</script></body>'
    const doc = buildCardDoc(loader)
    expect(doc).toContain('$("body").load')
    expect(doc).toMatch(/http-equiv="Content-Security-Policy"/i)
    expect(doc).toMatch(/<head>/i)
  })
})
