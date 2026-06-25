import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  importPresetFromFile,
  deletePreset,
  getActivePresetId,
  collectPresetRegex,
  collectPresetScripts
} from '../src/main/services/presetService'
import * as regexService from '../src/main/services/regexService'
import * as scriptService from '../src/main/services/scriptService'
import { getAppDir } from '../src/main/services/storageService'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
const tmpFiles: string[] = []
afterAll(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

// A minimal-but-real ST chat-completion preset that bundles regex + TH scripts under
// `extensions` (the shape we confirmed against the 命定之诗 / 双人成行 example presets).
const stPresetWithBundle = (name: string): any => ({
  name,
  temperature: 0.8,
  openai_max_tokens: 2048,
  prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Be {{char}}.' }],
  extensions: {
    regex_scripts: [
      {
        scriptName: 'beautify-suggestion',
        findRegex: '/<x>([\\s\\S]*?)<\\/x>/g',
        replaceString: '$1',
        placement: [2]
      },
      {
        scriptName: 'strip-tp',
        findRegex: '/<tp>[\\s\\S]*?<\\/tp>/g',
        replaceString: '',
        placement: [2]
      }
    ],
    tavern_helper: {
      scripts: [
        { type: 'script', enabled: true, name: 'MVU loader', content: "console.log('mvu')" },
        { type: 'script', enabled: false, name: 'disabled one', content: "console.log('off')" }
      ],
      variables: { some: 'thing' }
    }
  }
})

const writeTmpPreset = (raw: any): string => {
  const p = path.join(os.tmpdir(), `rpt-preset-${randomUUID()}.json`)
  fs.writeFileSync(p, JSON.stringify(raw), 'utf-8')
  tmpFiles.push(p)
  return p
}

describe('collectPreset* (pure extractors)', () => {
  it('pulls regex_scripts and tavern_helper.scripts from extensions', () => {
    const raw = stPresetWithBundle('X')
    expect(collectPresetRegex(raw)).toHaveLength(2)
    expect(collectPresetScripts(raw)).toHaveLength(2)
  })

  it('tolerates a top-level array wrapping the preset, and missing extensions', () => {
    expect(collectPresetRegex([stPresetWithBundle('Y')])).toHaveLength(2)
    expect(collectPresetScripts([stPresetWithBundle('Y')])).toHaveLength(2)
    expect(collectPresetRegex({ name: 'plain', prompts: [] })).toHaveLength(0)
    expect(collectPresetScripts(null)).toHaveLength(0)
  })
})

describe('importPresetFromFile — bundled regex/scripts', () => {
  it('imports the preset and routes its bundled artifacts scoped to the new preset', () => {
    const file = writeTmpPreset(stPresetWithBundle('Bundled Preset'))
    const result = importPresetFromFile(profileId, file)

    expect(result).not.toBeNull()
    expect(result!.name).toBe('Bundled Preset')
    expect(result!.regexScripts).toBe(2)
    expect(result!.scripts).toBe(2)

    const presetId = getActivePresetId(profileId) // import makes it active
    expect(presetId).toBeTruthy()

    // Regex: two preset-scoped scripts owned by this preset.
    const regexScripts = regexService.listScripts(profileId)
    expect(regexScripts).toHaveLength(2)
    expect(regexScripts.every((s) => s.scope === 'preset' && s.owner === presetId)).toBe(true)

    // Scripts: two preset-scoped (one disabled, mirroring its `enabled:false`).
    const scripts = scriptService.listScripts(profileId)
    expect(scripts).toHaveLength(2)
    expect(scripts.every((s) => s.scope === 'preset' && s.owner === presetId)).toBe(true)
    expect(scripts.find((s) => s.name === 'disabled one')!.disabled).toBe(true)
  })

  it('only resolves the bundled artifacts when that preset is the active context', () => {
    const presetId = getActivePresetId(profileId)!
    // Active preset → its regex + scripts fire.
    expect(regexService.getAllRules(profileId, { presetId })).toHaveLength(2)
    expect(scriptService.getActiveScripts(profileId, { presetId })).toHaveLength(1) // enabled only
    // A different active preset → none of them fire.
    expect(regexService.getAllRules(profileId, { presetId: 'other' })).toHaveLength(0)
    expect(scriptService.getActiveScripts(profileId, { presetId: 'other' })).toHaveLength(0)
  })

  it('deletePreset removes the preset-scoped artifacts it brought in (no orphans)', () => {
    const presetId = getActivePresetId(profileId)!
    deletePreset(profileId, presetId)
    expect(regexService.listScripts(profileId)).toHaveLength(0)
    expect(scriptService.listScripts(profileId)).toHaveLength(0)
  })
})
