import { describe, it, expect } from 'vitest'
import {
  stripParentRefs,
  remoteImportUrls,
  inlineRemoteModuleGraph
} from '../src/renderer/src/plugin/sourceRewrite'

/** Decode a `data:text/javascript;…,<encoded>` URL back to its source. */
const decodeDataUrl = (url: string): string =>
  decodeURIComponent(url.replace(/^data:text\/javascript;charset=utf-8,/, ''))

describe('stripParentRefs (frontend-card source rewrite)', () => {
  it('redirects window.top / window.parent reaches to the frame-local window', () => {
    // The reference card's env-check: window.top?.SillyTavern.getContext() must reach our shim.
    expect(stripParentRefs('const c = window.top?.SillyTavern.getContext()')).toBe(
      'const c = window?.SillyTavern.getContext()'
    )
    expect(stripParentRefs('window.parent.SillyTavern.getContext()')).toBe(
      'window.SillyTavern.getContext()'
    )
    expect(stripParentRefs('let w = window.top')).toBe('let w = window')
    expect(stripParentRefs("window.top['Mvu']")).toBe("window['Mvu']")
    expect(stripParentRefs('window . parent . foo')).toBe('window . foo') // tolerant of spacing
  })

  it('leaves unrelated identifiers and members intact', () => {
    expect(stripParentRefs('window.parentNode')).toBe('window.parentNode')
    expect(stripParentRefs('window.parentElement')).toBe('window.parentElement')
    expect(stripParentRefs('windows.top')).toBe('windows.top')
    expect(stripParentRefs('window.document.title')).toBe('window.document.title')
    expect(stripParentRefs('')).toBe('')
  })
})

describe('remoteImportUrls', () => {
  it('extracts absolute https specifiers from static, side-effect, and dynamic imports', () => {
    const code = [
      "import 'https://cdn/a.js';",
      "import x from 'https://cdn/b.js';",
      "export { y } from 'https://cdn/c.js';",
      "const m = await import('https://cdn/d.js');",
      "import rel from './local.js';" // relative — ignored
    ].join('\n')
    expect(remoteImportUrls(code).sort()).toEqual([
      'https://cdn/a.js',
      'https://cdn/b.js',
      'https://cdn/c.js',
      'https://cdn/d.js'
    ])
  })

  it('dedupes and returns [] for code with no remote imports', () => {
    expect(remoteImportUrls("import 'https://cdn/a.js';\nimport 'https://cdn/a.js';")).toEqual([
      'https://cdn/a.js'
    ])
    expect(remoteImportUrls("import './x.js'")).toEqual([])
    expect(remoteImportUrls('const x = 1')).toEqual([])
  })
})

describe('inlineRemoteModuleGraph', () => {
  it('converts a side-effect entry import to a non-blocking dynamic data: import', () => {
    const entry = "import 'https://cdn/index.js';\nconsole.log('after');"
    const graph = [{ url: 'https://cdn/index.js', source: 'export const v = 1;' }]
    const out = inlineRemoteModuleGraph(entry, graph)
    // Side-effect import → dynamic import().catch(...) so the rest of the script still runs.
    expect(out).toMatch(/import\("data:text\/javascript;charset=utf-8,[^"]+"\)\.catch\(/)
    expect(out).toContain("console.log('after');")
    const dataUrl = out.match(/"(data:[^"]+)"/)![1]
    expect(decodeDataUrl(dataUrl)).toBe('export const v = 1;')
  })

  it('keeps a bound entry import static (dynamic would lose the binding)', () => {
    const entry = "import x from 'https://cdn/index.js';\nx();"
    const graph = [{ url: 'https://cdn/index.js', source: 'export default () => 1;' }]
    const out = inlineRemoteModuleGraph(entry, graph)
    expect(out).toMatch(/import x from "data:text\/javascript;charset=utf-8,[^"]+";/)
    expect(out).not.toContain('.catch(')
  })

  it('inlines a dependency and rewrites the parent’s import to the child data: URL', () => {
    const entry = "import 'https://cdn/index.js';"
    const graph = [
      { url: 'https://cdn/index.js', source: "import './dep.js';\nexport const a = 1;" },
      { url: 'https://cdn/dep.js', source: 'export const b = 2;' }
    ]
    const out = inlineRemoteModuleGraph(entry, graph)
    const entryData = out.match(/"(data:[^"]+)"/)![1]
    const entrySrc = decodeDataUrl(entryData)
    // The parent's relative import was rewritten to the child's data: URL (also decodable).
    const childData = entrySrc.match(/"(data:[^"]+)"/)![1]
    expect(decodeDataUrl(childData)).toBe('export const b = 2;')
    expect(entrySrc).toContain('export const a = 1;')
  })

  it('neutralizes window.top/parent reaches inside inlined modules', () => {
    const entry = "import 'https://cdn/index.js';"
    const graph = [{ url: 'https://cdn/index.js', source: 'const c = window.top.SillyTavern;' }]
    const out = inlineRemoteModuleGraph(entry, graph)
    expect(decodeDataUrl(out.match(/"(data:[^"]+)"/)![1])).toBe('const c = window.SillyTavern;')
  })

  it('leaves specifiers not present in the graph untouched', () => {
    const entry = "import 'https://cdn/missing.js';"
    expect(inlineRemoteModuleGraph(entry, [])).toBe("import 'https://cdn/missing.js';")
  })
})
