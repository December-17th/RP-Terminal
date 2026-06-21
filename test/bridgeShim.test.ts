import { describe, it, expect } from 'vitest'
import { isModuleScript, buildScriptSrcDoc } from '../src/renderer/src/plugin/bridgeShim'

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
    expect(locked).not.toContain('https:')

    const open = buildScriptSrcDoc([{ name: 's', code: 'x()' }], { allowRemote: true })
    expect(open).toContain("script-src 'unsafe-inline' https:")
    expect(open).toContain('connect-src https:')
  })
})
