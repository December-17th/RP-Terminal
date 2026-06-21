import { describe, it, expect } from 'vitest'
import {
  isModuleScript,
  buildScriptSrcDoc,
  buildMessageHtmlDoc,
  isInteractiveHtml
} from '../src/renderer/src/plugin/bridgeShim'

describe('isModuleScript', () => {
  it('detects static import/export forms, not dynamic import() or strings', () => {
    expect(isModuleScript("import 'x'")).toBe(true)
    expect(isModuleScript("import a from 'x'")).toBe(true)
    expect(isModuleScript('import { a } from "x"')).toBe(true)
    expect(isModuleScript("import * as a from 'x'")).toBe(true)
    expect(isModuleScript("import{klona}from'x'")).toBe(true) // minified
    expect(isModuleScript('export const x = 1')).toBe(true)
    expect(isModuleScript("const y = await import('x')")).toBe(false) // dynamic-only → classic
    expect(isModuleScript("rpt.ui.toast('hi')")).toBe(false)
  })
})

describe('buildScriptSrcDoc', () => {
  it('runs module-syntax scripts as type=module and classic scripts in try/catch', () => {
    const doc = buildScriptSrcDoc([
      { name: 'esm', code: "import 'https://cdn/x.js'" },
      { name: 'plain', code: 'doThing()' }
    ])
    expect(doc).toContain('<script type="module">')
    expect(doc).toContain("import 'https://cdn/x.js'")
    expect(doc).toContain('try {\ndoThing()') // classic one is wrapped
  })

  it('locks the CSP by default and opens https only when allowRemote', () => {
    const locked = buildScriptSrcDoc([{ name: 's', code: 'x()' }])
    expect(locked).toContain("connect-src 'none'")
    // The locked CSP must not open the network — check the directives, not a blanket
    // 'https:' (shim code legitimately contains https in regexes/URLs).
    expect(locked).not.toContain('connect-src https:')
    expect(locked).not.toContain("script-src 'unsafe-inline' https:")

    const open = buildScriptSrcDoc([{ name: 's', code: 'x()' }], { allowRemote: true })
    expect(open).toContain("script-src 'unsafe-inline' https:")
    expect(open).toContain('connect-src https:')
  })

  it('injects the lib-loader (host-fetched Vue global) only when allowRemote', () => {
    const locked = buildScriptSrcDoc([{ name: 's', code: "import 'x'" }])
    expect(locked).not.toContain('vue.global.prod.js')

    const open = buildScriptSrcDoc([{ name: 's', code: "import 'x'" }], { allowRemote: true })
    // Vue is loaded by host-fetching its UMD build + running it inline (cross-origin
    // import() fails in the opaque sandbox).
    expect(open).toContain('vue.global.prod.js')
  })

  it('exposes the Tavern Helper globals (eventOn + jQuery stub) to scripts', () => {
    const doc = buildScriptSrcDoc([{ name: 's', code: 'x()' }])
    expect(doc).toContain('window.eventOn')
    expect(doc).toContain('window.jQuery')
  })
})

describe('isInteractiveHtml (TH-6)', () => {
  it('detects an embedded <script>, ignores plain markup', () => {
    expect(isInteractiveHtml('<div>hi</div><script>doThing()</script>')).toBe(true)
    expect(isInteractiveHtml('<script src="x.js"></script>')).toBe(true)
    expect(isInteractiveHtml('<div class="card">just markup</div>')).toBe(false)
  })
})

describe('buildMessageHtmlDoc (TH-6)', () => {
  it('inlines the model HTML with the rpt + TH shims under a locked CSP', () => {
    const doc = buildMessageHtmlDoc('<div id="ui">x</div><script>rpt.log("hi")</script>')
    expect(doc).toContain('<div id="ui">x</div>')
    expect(doc).toContain('rpt.log("hi")')
    expect(doc).toContain('rpt.v1') // BRIDGE_SHIM present
    expect(doc).toContain('TavernHelper') // TAVERN_SHIM present
    expect(doc).toContain("connect-src 'none'") // network off by default
    expect(doc).not.toContain('connect-src https:')
  })

  it('extracts the <body> of a full document', () => {
    const doc = buildMessageHtmlDoc(
      '<!doctype html><html><head><title>t</title></head><body><p>inner</p></body></html>'
    )
    expect(doc).toContain('<p>inner</p>')
    expect(doc).not.toContain('<title>t</title>')
  })
})

describe('jQuery shim (frontend cards)', () => {
  it('ships a real DOM-backed mini-jQuery with a working .load', () => {
    const doc = buildScriptSrcDoc([{ name: 's', code: 'x()' }])
    expect(doc).toContain('window.$ = window.jQuery')
    expect(doc).toContain('p.load = function')
  })
})

describe('buildMessageHtmlDoc remote grant (TH-6)', () => {
  it('opens the CSP for the network when allowRemote is granted', () => {
    const locked = buildMessageHtmlDoc('<body><script>x()</script></body>')
    expect(locked).toContain("connect-src 'none'")
    const open = buildMessageHtmlDoc('<body><script>x()</script></body>', { allowRemote: true })
    expect(open).toContain('connect-src https:')
  })
})
