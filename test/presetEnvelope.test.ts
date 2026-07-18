import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID, createHash } from 'crypto'
import {
  importPresetFromFile,
  installBundledPreset,
  savePreset,
  deletePreset,
  getActivePresetId,
  getPresetById,
  listPresets,
  readEnvelope,
  isLossyImport,
  getPresetProvenance,
  exportPresetSemantic,
  exportPresetOriginal
} from '../src/main/services/presetService'
import { getAppDir } from '../src/main/services/storageService'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
const tmpFiles: string[] = []
afterAll(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

/**
 * A synthesized ST chat-completion preset. All prose is invented gibberish — NOT lifted
 * from any real preset or ST default (clean-room fixtures). Carries the fields RPT's
 * normalized view drops so we can prove the envelope keeps them: multiple `prompt_order`
 * lists (incl. the 100001 dummy character), prompt-level `injection_order`/
 * `injection_trigger`/`forbid_overrides`/`marker`, full `extensions.*` (incl. an unknown
 * custom namespace), and an unknown top-level key.
 */
const synthPreset = (name: string): any => ({
  name,
  temperature: 0.77,
  openai_max_tokens: 3210,
  top_p: 0.91,
  wobble_unknown_top_level: 'gribble the frobnitz sideways', // unknown top-level field
  prompts: [
    {
      identifier: 'main',
      name: 'Main',
      role: 'system',
      content: 'Wobble as {{char}}; spindle the violet gizmos twice.',
      injection_order: 100,
      injection_trigger: [],
      forbid_overrides: true,
      marker: false
    },
    {
      identifier: 'jailbreak',
      name: 'Jailbreak',
      role: 'system',
      content: 'Flumph the {{user}} through nine crinkled hoops.',
      injection_order: 200,
      forbid_overrides: false
    },
    { identifier: 'chatHistory', name: 'Chat History', marker: true }
  ],
  prompt_order: [
    { character_id: 200042, order: [{ identifier: 'main', enabled: false }] },
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true }
      ]
    }
  ],
  extensions: {
    tavern_helper: { scripts: [], variables: { snorb: 'zibble' } },
    SPreset: { flavor: 'quorm', knobs: [3, 1, 4] },
    custom_namespace: { keepme: 'the plum wibbles unbothered' } // unknown extension namespace
  }
})

const writeTmpPreset = (raw: any): string => {
  const p = path.join(os.tmpdir(), `rpt-env-${randomUUID()}.json`)
  fs.writeFileSync(p, JSON.stringify(raw), 'utf-8')
  tmpFiles.push(p)
  return p
}

describe('Preset Envelope — lossless persistence (ADR 0018)', () => {
  it('imports and persists an envelope alongside the normalized view', () => {
    const file = writeTmpPreset(synthPreset('Envelope A'))
    const result = importPresetFromFile(profileId, file)
    expect(result).not.toBeNull()

    const id = getActivePresetId(profileId)!
    const env = readEnvelope(profileId, id)
    expect(env).not.toBeNull()
    expect(env!.importerVersion).toBe('rpt-st-preset/1')
    expect(env!.sha256).toBeTruthy()
    expect(env!.originalBase64).toBeTruthy()
    // Envelope keeps everything the normalized view drops.
    expect(env!.parsed.prompt_order).toHaveLength(2)
    expect(env!.parsed.prompts[0].injection_order).toBe(100)
    expect(env!.parsed.prompts[0].forbid_overrides).toBe(true)
    expect(env!.parsed.extensions.SPreset.flavor).toBe('quorm')
  })

  it('round-trips SEMANTIC: export JSON.parse-equals the imported (unedited) source', () => {
    const raw = synthPreset('Envelope Semantic')
    const file = writeTmpPreset(raw)
    importPresetFromFile(profileId, file)
    const id = getActivePresetId(profileId)!

    const exported = exportPresetSemantic(profileId, id)
    expect(exported).not.toBeNull()
    expect(JSON.parse(exported!)).toEqual(raw) // semantic equality, key-order agnostic
  })

  it('survives unknown top-level + extensions.custom_namespace through import/export', () => {
    const file = writeTmpPreset(synthPreset('Envelope Unknowns'))
    importPresetFromFile(profileId, file)
    const id = getActivePresetId(profileId)!
    const out = JSON.parse(exportPresetSemantic(profileId, id)!)
    expect(out.wobble_unknown_top_level).toBe('gribble the frobnitz sideways')
    expect(out.extensions.custom_namespace.keepme).toBe('the plum wibbles unbothered')
  })

  it('round-trips BYTE-EXACT for a never-edited preset, and the SHA matches', () => {
    // Hand-authored bytes with irregular indentation, scrambled key order and a trailing
    // newline — re-serialization would NOT reproduce these, so an exact match proves fidelity.
    const rawText =
      '{\n    "name": "Byte Exact",\n  "openai_max_tokens": 999,\n      "temperature": 0.5,\n' +
      '   "prompts": [ {"identifier":"main","content":"Zort the {{char}} gently."} ]\n}\n'
    const file = path.join(os.tmpdir(), `rpt-env-bytes-${randomUUID()}.json`)
    fs.writeFileSync(file, rawText, 'utf-8')
    tmpFiles.push(file)

    importPresetFromFile(profileId, file)
    const id = getActivePresetId(profileId)!
    const original = exportPresetOriginal(profileId, id)
    expect(original).not.toBeNull()
    expect(original!.toString('utf-8')).toBe(rawText) // byte-identical to the source file

    const env = readEnvelope(profileId, id)!
    expect(createHash('sha256').update(original!).digest('hex')).toBe(env.sha256)
  })

  it('edits mutate the view in place; envelope stays untouched (provenance, not state)', () => {
    const file = writeTmpPreset(synthPreset('Envelope Edited'))
    importPresetFromFile(profileId, file)
    const id = getActivePresetId(profileId)!
    const before = readEnvelope(profileId, id)!

    const view = getPresetById(profileId, id)!
    savePreset(profileId, id, { ...view, name: 'Renamed In Place' })

    const after = readEnvelope(profileId, id)!
    expect(after).toEqual(before) // envelope bytes/hash describe the import, not the edit
    // Semantic export reflects the edit (name written back onto the existing key)…
    expect(JSON.parse(exportPresetSemantic(profileId, id)!).name).toBe('Renamed In Place')
    // …while byte-exact export still returns the original import verbatim.
    expect(exportPresetOriginal(profileId, id)!.toString('utf-8')).toContain('"name":"Envelope Edited"')
  })

  it('bundled (pre-parsed) presets get a lossless envelope but no byte-exact export', () => {
    const name = installBundledPreset(profileId, synthPreset('Envelope Bundled'))
    expect(name).toBe('Envelope Bundled')
    const id = listPresets(profileId).find((p) => p.name === 'Envelope Bundled')!.id
    const prov = getPresetProvenance(profileId, id)!
    expect(prov.hasEnvelope).toBe(true)
    expect(prov.canExportOriginal).toBe(false) // no original bytes for a bundle
    expect(exportPresetOriginal(profileId, id)).toBeNull()
    // Semantic export is still lossless (extensions survive).
    expect(JSON.parse(exportPresetSemantic(profileId, id)!).extensions.SPreset.flavor).toBe('quorm')
  })

  it('flags pre-envelope presets as lossy-import; deletePreset removes the envelope', () => {
    const file = writeTmpPreset(synthPreset('Envelope Delete'))
    importPresetFromFile(profileId, file)
    const id = getActivePresetId(profileId)!
    expect(isLossyImport(profileId, id)).toBe(false)
    expect(getPresetProvenance(profileId, id)!.lossyImport).toBe(false)

    deletePreset(profileId, id)
    expect(readEnvelope(profileId, id)).toBeNull()
    expect(getPresetProvenance(profileId, id)).toBeNull() // preset record gone too

    // A normalized record with no envelope (pre-ADR-0018 import) reads as lossy.
    const legacyId = randomUUID()
    fs.mkdirSync(path.join(profileDir, 'presets'), { recursive: true })
    fs.writeFileSync(
      path.join(profileDir, 'presets', `${legacyId}.json`),
      JSON.stringify({ name: 'Legacy', parameters: { temperature: 0.9, max_tokens: 4000 }, prompts: [] })
    )
    expect(isLossyImport(profileId, legacyId)).toBe(true)
    expect(getPresetProvenance(profileId, legacyId)!.lossyImport).toBe(true)
  })
})
