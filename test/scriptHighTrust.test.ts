// test/scriptHighTrust.test.ts
//
// Issue 19 item 3 (preserve upstream script id + ID-sorted runtime order) and item 5 (high-trust mode:
// remote-code scripts run ONLY in the isolated WCV realm — the app renderer / main / keys stay
// unreachable at EVERY trust level).
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  saveScript,
  getScript,
  getActiveScripts,
  setScriptHighTrust,
  normalizeImportedScripts
} from '../src/main/services/scriptService'
import { getAppDir } from '../src/main/services/storageService'
import { isScopeActive } from '../src/shared/artifactScope'
import { createNullHost } from '../src/shared/thRuntime/nullHost'
import type { Host } from '../src/shared/thRuntime/types'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('upstream script id preservation (issue 03 fix)', () => {
  it('normalizeImportedScripts carries the TH id, and saveScript persists it', () => {
    const [s] = normalizeImportedScripts({
      type: 'script',
      name: 'MVU',
      id: 'th-abc-123',
      content: 'x()'
    })
    expect(s.id).toBe('th-abc-123')
    const file = saveScript(profileId, { name: s.name, code: s.code, id: s.id })
    expect(getScript(profileId, file)!.id).toBe('th-abc-123') // survives the round-trip
  })

  it('getActiveScripts runs enabled scripts in ID-sorted order (F1-guarded)', () => {
    const p2 = `test-${randomUUID()}`
    saveScript(p2, { name: 'Zeta', code: 'a()', id: 'id-30' })
    saveScript(p2, { name: 'Alpha', code: 'b()', id: 'id-10' })
    saveScript(p2, { name: 'Mid', code: 'c()', id: 'id-20' })
    saveScript(p2, { name: 'NoId', code: 'd()' }) // id-less native sorts last
    const order = getActiveScripts(p2, {}).map((s) => s.name)
    expect(order).toEqual(['Alpha', 'Mid', 'Zeta', 'NoId'])
    fs.rmSync(path.join(getAppDir(), 'profiles', p2), { recursive: true, force: true })
  })
})

describe('high-trust realm gate (ADR 0017 — the isolated-realm boundary)', () => {
  it('a high-trust script resolves ONLY in the isolated realm, never the app renderer', () => {
    const p3 = `test-${randomUUID()}`
    const file = saveScript(
      p3,
      { name: 'remote-loader', code: "import 'https://cdn/x.mjs'", id: 'ht-1' },
      'preset',
      'preset-A'
    )
    setScriptHighTrust(p3, file, true)

    const ctx = { presetId: 'preset-A' }
    // Inline transport (app renderer): isolatedRealm unset → the high-trust script is EXCLUDED.
    expect(getActiveScripts(p3, ctx).map((s) => s.name)).not.toContain('remote-loader')
    // WCV transport (isolated realm): isolatedRealm true → it resolves.
    expect(getActiveScripts(p3, { ...ctx, isolatedRealm: true }).map((s) => s.name)).toContain(
      'remote-loader'
    )
    fs.rmSync(path.join(getAppDir(), 'profiles', p3), { recursive: true, force: true })
  })

  it('isScopeActive gates a high-trust artifact on isolatedRealm regardless of scope match', () => {
    const meta = { scope: 'preset' as const, owner: 'preset-A', highTrust: true }
    expect(isScopeActive(meta, { presetId: 'preset-A' })).toBe(false) // right scope, wrong realm
    expect(isScopeActive(meta, { presetId: 'preset-A', isolatedRealm: true })).toBe(true)
    // A non-high-trust artifact is unaffected by the realm flag (runs in either realm).
    const normal = { scope: 'preset' as const, owner: 'preset-A' }
    expect(isScopeActive(normal, { presetId: 'preset-A' })).toBe(true)
  })
})

describe('Host seam carries no app-renderer / main / key surface (boundary invariant)', () => {
  it('the ONLY app surface a card (at any trust level) reaches is the enumerated Host — and it holds no key/ipc/fs/process member', () => {
    // The card realm's sole bridge to the app is the Host seam. Even a high-trust remote-code script in
    // the isolated WCV realm can call nothing outside these members. None of them exposes the app renderer
    // DOM, the main process, `require`/`process`/`fs`, or the API keys (those stay main-side, behind
    // generate()). This pins that invariant: a member that leaked such a surface would show up here.
    const members = Object.keys(createNullHost() as unknown as Record<string, unknown>)
    // Names that would signal a leaked app-renderer / main / key surface. (evalTemplate/evalTemplateError
    // are the BOUNDED EJS engine hooks — part of the contract, not a raw `eval` into the app — so `eval` is
    // deliberately not in this list.)
    const forbidden = /apikey|api_key|secret|token|ipc|renderer|require|process|\bfs\b|electron|window|document/i
    const leaks = members.filter((m) => forbidden.test(m))
    expect(leaks).toEqual([])
    // Sanity: the Host DOES carry the documented capability members.
    expect(members).toContain('generate') // the only path to the model; keys never cross the seam
    expect(members).toContain('preset')
    expect(members).toContain('setExtensionSettings')
  })

  it('createNullHost is a complete inert Host (spread base) with no throwing member', () => {
    const host = createNullHost() as Host
    // A high-trust script that reaches the seam gets safe neutrals, never app internals.
    expect(host.getExtensionSettingsSync()).toEqual({})
    expect(host.preset()).toBeNull()
  })
})
