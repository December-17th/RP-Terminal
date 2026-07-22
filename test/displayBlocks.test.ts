// @vitest-environment jsdom
//
// The shared card-facing segmentation module (src/shared/displayBlocks.ts, ADR 0023 companion). The
// exhaustive splitHtml / stripUnknownHtmlTags behavior is pinned by test/messageContent.test.ts +
// test/splitHtmlMode.test.ts against the renderer re-export; this file guards the MOVE (re-export
// identity), a couple of segmentation smoke cases, isInteractiveHtml, and the new applyScriptedHtml
// DOM helper (jsdom).
import { describe, it, expect, vi } from 'vitest'

// This file runs under jsdom (for applyScriptedHtml). Importing the renderer re-export below pulls in
// MessageContent's whole module graph, and InlineCardFrame.tsx installs a card top-surface at module
// load (→ window.api.listLorebooks), which throws under jsdom where window exists but window.api does
// not. Stub the component so the re-export identity check doesn't drag that side effect in; the pure
// segmentation functions we actually test live in the shared module, untouched by this mock.
vi.mock('../src/renderer/src/components/InlineCardFrame', () => ({
  InlineCardFrame: () => null
}))

import {
  splitHtml,
  isInteractiveHtml,
  stripUnknownHtmlTags,
  applyScriptedHtml
} from '../src/shared/displayBlocks'
import {
  splitHtml as splitHtmlReexport,
  stripUnknownHtmlTags as stripReexport
} from '../src/renderer/src/components/MessageContent'
import { isInteractiveHtml as isInteractiveReexport } from '../src/renderer/src/plugin/bridgeShim'

describe('displayBlocks re-export identity (the MOVE is byte-identical, not a fork)', () => {
  it('renderer re-exports point at the SAME shared functions', () => {
    expect(splitHtmlReexport).toBe(splitHtml)
    expect(stripReexport).toBe(stripUnknownHtmlTags)
    expect(isInteractiveReexport).toBe(isInteractiveHtml)
  })
})

describe('splitHtml segmentation (smoke)', () => {
  it('lifts a ```html fenced card out of the surrounding prose', () => {
    const segs = splitHtml('before\n```html\n<div>x</div>\n```\nafter')
    expect(segs.map((s) => s.type)).toContain('html')
    expect(segs.find((s) => s.type === 'html')!.text).toContain('<div>x</div>')
    expect(segs.some((s) => s.type === 'md' && s.text.includes('before'))).toBe(true)
    expect(segs.some((s) => s.type === 'md' && s.text.includes('after'))).toBe(true)
  })

  it('leaves plain markdown as a single md segment', () => {
    const md = 'just some text with no html'
    expect(splitHtml(md)).toEqual([{ type: 'md', text: md }])
  })
})

describe('isInteractiveHtml', () => {
  it('detects an embedded <script>, ignores plain markup', () => {
    expect(isInteractiveHtml('<div>hi</div><script>doThing()</script>')).toBe(true)
    expect(isInteractiveHtml('<script src="x.js"></script>')).toBe(true)
    expect(isInteractiveHtml('<div class="card">just markup</div>')).toBe(false)
  })
})

describe('applyScriptedHtml (jsdom)', () => {
  // Inline scripts execute in jsdom's realm (runScripts: 'dangerously') only once inserted into a
  // CONNECTED document, and window globals do NOT bridge to the test realm — so each script signals
  // its execution by mutating the container DOM (a data-attribute), which we then assert on. Each
  // case mounts its container under document.body so the re-created script actually runs.
  const html = '<div id="host"></div><script>document.getElementById("host").dataset.ran = "1"</script>'
  const mount = (): HTMLElement => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    return el
  }

  it('(a) a plain innerHTML assignment leaves the <script> inert', () => {
    const el = mount()
    el.innerHTML = html
    expect(el.querySelector('#host')!.getAttribute('data-ran')).toBe(null)
    el.remove()
  })

  it('(b) applyScriptedHtml re-creates the script so it runs', () => {
    const el = mount()
    applyScriptedHtml(el, html)
    expect(el.querySelector('#host')!.getAttribute('data-ran')).toBe('1')
    el.remove()
  })

  it('(c) preserves the re-created script’s attributes', () => {
    const el = mount()
    applyScriptedHtml(el, '<script id="s1" type="text/javascript" data-x="y">void 0</script>')
    const s = el.querySelector('script#s1')!
    expect(s.getAttribute('type')).toBe('text/javascript')
    expect(s.getAttribute('data-x')).toBe('y')
    el.remove()
  })
})
