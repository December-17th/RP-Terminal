import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  extractImports,
  extractImportHosts,
  runtimeImportHosts,
  normalizeImportedScripts,
  saveScript,
  listScripts,
  getScript,
  updateScript,
  setScriptScope,
  setScriptDisabled,
  deleteScript,
  getActiveScripts
} from '../src/main/services/scriptService'
import { getAppDir } from '../src/main/services/storageService'

describe('extractImports', () => {
  it('finds every static + dynamic + directive import form (and dedups)', () => {
    const code = [
      "import 'https://a.com/side.js';", // side-effect (the real MVU form)
      "import Default from 'https://b.com/d.js'", // default
      "import { x, y } from 'https://c.com/named.js'", // named
      "import * as ns from 'https://d.com/star.js'", // namespace
      "export { z } from 'https://e.com/re.js'", // re-export
      "const m = await import('https://f.com/dyn.js')", // dynamic
      '// @import https://g.com/directive.js', // comment directive
      'const k = "import not-a-real one"' // string, ignored
    ].join('\n')
    expect(extractImports(code).sort()).toEqual(
      [
        'https://a.com/side.js',
        'https://b.com/d.js',
        'https://c.com/named.js',
        'https://d.com/star.js',
        'https://e.com/re.js',
        'https://f.com/dyn.js',
        'https://g.com/directive.js'
      ].sort()
    )
  })

  it('handles minified imports with no spaces', () => {
    expect(extractImports("import{klona as e}from'https://cdn/klona/+esm';")).toEqual([
      'https://cdn/klona/+esm'
    ])
  })

  it('returns [] when there are no imports', () => {
    expect(extractImports('const x = 1\nfoo()')).toEqual([])
  })
})

describe('extractImportHosts / runtimeImportHosts', () => {
  it('returns distinct hosts of absolute-URL imports only', () => {
    const code =
      "import 'https://cdn.example/a.js'\nimport x from 'https://cdn.example/b.js'\nimport './local.js'"
    expect(extractImportHosts(code)).toEqual(['cdn.example']) // deduped; relative skipped
  })

  it('unions hosts across the runtime script set', () => {
    const scripts = [
      { name: 'a', code: "import 'https://one.cdn/x.js'" },
      { name: 'b', code: "import y from 'https://two.cdn/y.js'" },
      { name: 'c', code: 'plain()' }
    ]
    expect(runtimeImportHosts(scripts).sort()).toEqual(['one.cdn', 'two.cdn'])
  })
})

describe('normalizeImportedScripts (Tavern Helper JSON)', () => {
  it('maps a TH script: content→code, name/enabled, visible buttons→auto-registerButton', () => {
    const th = {
      type: 'script',
      enabled: true,
      name: '【命定之诗】MVU beta',
      content: "import 'https://cdn/bundle.js';",
      button: {
        enabled: true,
        buttons: [
          { name: '重新读取初始变量', visible: true },
          { name: '清除旧楼层变量', visible: false } // hidden → skipped
        ]
      }
    }
    const [s] = normalizeImportedScripts(th)
    expect(s.name).toBe('【命定之诗】MVU beta')
    expect(s.enabled).toBe(true)
    expect(s.code).toContain("import 'https://cdn/bundle.js';") // original content kept
    expect(s.code).toContain('rpt.ui.registerButton') // buttons baked in
    expect(s.code).toContain('重新读取初始变量')
    expect(s.code).toContain('getButtonEvent') // click emits getButtonEvent(name) for TH eventOn
    expect(s.code).not.toContain('清除旧楼层变量') // the hidden one is dropped
  })

  it('accepts an array, the native {name,code} shape, and honors enabled:false', () => {
    const out = normalizeImportedScripts([
      { type: 'script', name: 'a', content: 'x()' },
      { name: 'native', code: 'y()' },
      { type: 'script', name: 'off', content: 'z()', enabled: false },
      { name: 'junk' }, // no code → skipped
      null
    ])
    expect(out.map((s) => s.name)).toEqual(['a', 'native', 'off'])
    expect(out.find((s) => s.name === 'off')!.enabled).toBe(false)
    expect(out.find((s) => s.name === 'a')!.code).toBe('x()') // no buttons → code unchanged
  })
})

// Integration: store CRUD + scope against the test app dir.
const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('scripts store', () => {
  it('saves, lists, scopes, toggles and resolves active scripts by context', () => {
    const g = saveScript(profileId, { name: 'global-one', code: 'a()' })
    const w = saveScript(
      profileId,
      { name: 'world-A', code: 'import "https://x/y.js"\nb()' },
      'world',
      'card-A'
    )
    const s = saveScript(profileId, { name: 'session-1', code: 'c()' }, 'session', 'chat-1')

    const all = listScripts(profileId)
    expect(all).toHaveLength(3)
    expect(all.find((x) => x.file === w)!.remoteHosts).toEqual(['x']) // surfaces remote host
    expect(all.find((x) => x.file === w)!.scope).toBe('world')

    // No context → none of the scoped scripts (only global).
    expect(getActiveScripts(profileId, {}).map((x) => x.name)).toEqual(['global-one'])
    // Right world → global + world-A.
    expect(
      getActiveScripts(profileId, { cardId: 'card-A' })
        .map((x) => x.name)
        .sort()
    ).toEqual(['global-one', 'world-A'])
    // Right world + session → all three.
    expect(getActiveScripts(profileId, { cardId: 'card-A', chatId: 'chat-1' })).toHaveLength(3)

    // Disable global-one → it drops out of the active set but stays in the list.
    setScriptDisabled(profileId, g, true)
    expect(getActiveScripts(profileId, { cardId: 'card-A' }).map((x) => x.name)).toEqual([
      'world-A'
    ])
    expect(listScripts(profileId).find((x) => x.file === g)!.disabled).toBe(true)

    // Rescope world-A to global keeps its disabled flag intact (false here) + drops owner.
    setScriptScope(profileId, w, 'global')
    const reW = listScripts(profileId).find((x) => x.file === w)!
    expect(reW.scope).toBe('global')
    expect(reW.owner).toBeUndefined()

    // Edit + read back.
    updateScript(profileId, s, { code: 'updated()' })
    expect(getScript(profileId, s)!.code).toBe('updated()')

    // Delete clears file + meta.
    deleteScript(profileId, s)
    expect(listScripts(profileId).some((x) => x.file === s)).toBe(false)
  })

  it('rejects path-traversal filenames', () => {
    expect(getScript(profileId, '../evil.json')).toBeNull()
    expect(getScript(profileId, '_meta.json')).toBeNull()
  })
})
