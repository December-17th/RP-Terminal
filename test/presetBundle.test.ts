import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  installBundledPreset,
  listPresets,
  getActivePresetId,
  createEmptyPreset,
  getPresetById
} from '../src/main/services/presetService'
import { getAppDir } from '../src/main/services/storageService'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

const nativePreset = (name: string) => ({
  name,
  parameters: { temperature: 0.7, max_tokens: 1234 },
  prompts: [{ identifier: 'main', role: 'system', content: 'Be {{char}}.', marker: 'none' }]
})

describe('installBundledPreset', () => {
  it('installs a native bundled preset without hijacking the active preset', () => {
    // An explicitly-active preset must stay active after a bundle installs.
    const active = createEmptyPreset(profileId, 'My Active')
    const name = installBundledPreset(profileId, nativePreset('Bundled A'))
    expect(name).toBe('Bundled A')
    expect(listPresets(profileId).map((p) => p.name)).toContain('Bundled A')
    expect(getActivePresetId(profileId)).toBe(active.id)
  })

  it('preserves parameters + prompts of the installed preset', () => {
    installBundledPreset(profileId, nativePreset('Bundled B'))
    const id = listPresets(profileId).find((p) => p.name === 'Bundled B')!.id
    const preset = getPresetById(profileId, id)!
    expect(preset.parameters.max_tokens).toBe(1234)
    expect(preset.prompts[0].content).toBe('Be {{char}}.')
  })

  it('dedups by name (idempotent re-import) and rejects junk', () => {
    const before = listPresets(profileId).length
    expect(installBundledPreset(profileId, nativePreset('Bundled A'))).toBeNull() // already exists
    expect(listPresets(profileId).length).toBe(before)
    expect(installBundledPreset(profileId, 42)).toBeNull()
    expect(installBundledPreset(profileId, null)).toBeNull()
  })
})
