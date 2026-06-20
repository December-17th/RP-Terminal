import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  extractImports,
  inlineImports,
  resolveRemoteImports,
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
  it('finds import "url", import \'url\', and // @import url; dedups', () => {
    const code = [
      'import "https://a.com/x.js"',
      "import 'https://b.com/y.js' ;",
      '// @import https://a.com/x.js',
      '// @import   https://c.com/z.js',
      'const k = "import not-a-directive"'
    ].join('\n')
    expect(extractImports(code)).toEqual([
      'https://a.com/x.js',
      'https://b.com/y.js',
      'https://c.com/z.js'
    ])
  })

  it('returns [] when there are no import directives', () => {
    expect(extractImports('const x = 1\nfoo()')).toEqual([])
  })
})

describe('inlineImports', () => {
  it('replaces resolved directives with the fetched code and neutralizes the rest', () => {
    const code = 'import "https://a.com/x.js"\nrun()\n// @import https://miss.com/m.js'
    const out = inlineImports(code, { 'https://a.com/x.js': 'window.LIB=1' })
    expect(out).toContain('window.LIB=1')
    expect(out).toContain('run()')
    expect(out).toContain('not loaded') // the unresolved one is commented out
    expect(out).not.toMatch(/^import /m) // no raw import lines remain
  })
})

describe('resolveRemoteImports (no-fetch paths)', () => {
  it('passes code through unchanged when there are no imports', async () => {
    const r = await resolveRemoteImports('p', 'plain()', true)
    expect(r).toEqual({ code: 'plain()', hosts: [] })
  })

  it('reports hosts but does not fetch when not allowed', async () => {
    const r = await resolveRemoteImports('p', 'import "https://cdn.example/x.js"\ngo()', false)
    expect(r.hosts).toEqual(['cdn.example'])
    expect(r.code).toContain('not loaded')
    expect(r.code).toContain('go()')
  })
})

// Integration: store CRUD + scope against the test app dir.
const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('scripts store', () => {
  it('saves, lists, scopes, toggles and resolves active scripts by context', () => {
    const g = saveScript(profileId, { name: 'global-one', code: 'a()' })
    const w = saveScript(profileId, { name: 'world-A', code: 'import "https://x/y.js"\nb()' }, 'world', 'card-A')
    const s = saveScript(profileId, { name: 'session-1', code: 'c()' }, 'session', 'chat-1')

    const all = listScripts(profileId)
    expect(all).toHaveLength(3)
    expect(all.find((x) => x.file === w)!.remoteHosts).toEqual(['x']) // surfaces remote host
    expect(all.find((x) => x.file === w)!.scope).toBe('world')

    // No context → none of the scoped scripts (only global).
    expect(getActiveScripts(profileId, {}).map((x) => x.name)).toEqual(['global-one'])
    // Right world → global + world-A.
    expect(getActiveScripts(profileId, { cardId: 'card-A' }).map((x) => x.name).sort()).toEqual([
      'global-one',
      'world-A'
    ])
    // Right world + session → all three.
    expect(getActiveScripts(profileId, { cardId: 'card-A', chatId: 'chat-1' })).toHaveLength(3)

    // Disable global-one → it drops out of the active set but stays in the list.
    setScriptDisabled(profileId, g, true)
    expect(getActiveScripts(profileId, { cardId: 'card-A' }).map((x) => x.name)).toEqual(['world-A'])
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
