// test/presetSemanticExportEdits.test.ts
//
// ADR 0018 (G — lossless semantic export): `exportPresetSemantic` must reflect the CURRENT edited state
// of a preset — prompt content/role edits, reordering, enablement toggles, additions AND deletions — not
// revert prompt structure to the imported bytes. The envelope stays the untouched provenance record;
// the export overlays the edited normalized view onto it (preserving extensions + unmodeled fields).
//
// All prose is invented gibberish (clean-room fixtures — never lifted from a real preset).
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  importPresetFromFile,
  getActivePresetId,
  getPresetById,
  savePreset,
  exportPresetSemantic
} from '../src/main/services/presetService'
import { getAppDir } from '../src/main/services/storageService'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
const tmpFiles: string[] = []
afterAll(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

// A minimal ST chat-completion preset with a 100001 prompt_order list, an unknown extension namespace,
// and an unknown top-level key — so the test also proves losslessness survives the edit overlay.
const synthPreset = (name: string): any => ({
  name,
  temperature: 0.6,
  openai_max_tokens: 2048,
  quirk_top_level: 'the wibbling frobnitz remains',
  prompts: [
    { identifier: 'main', name: 'Main', role: 'system', content: 'Alpha wobble as {{char}}.', marker: false },
    { identifier: 'lore', name: 'Lore', role: 'system', content: 'Beta spindle the gizmos.', marker: false },
    { identifier: 'jailbreak', name: 'Jailbreak', role: 'system', content: 'Gamma flumph nine hoops.', marker: false }
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'lore', enabled: true },
        { identifier: 'jailbreak', enabled: true }
      ]
    }
  ],
  extensions: { custom_ns: { keepme: 'the plum wibbles unbothered' } }
})

const writeTmp = (raw: any): string => {
  const p = path.join(os.tmpdir(), `rpt-sxe-${randomUUID()}.json`)
  fs.writeFileSync(p, JSON.stringify(raw), 'utf-8')
  tmpFiles.push(p)
  return p
}

const orderOf = (out: any): Array<{ identifier: string; enabled?: boolean }> =>
  out.prompt_order.find((o: any) => o.character_id === 100001).order

const promptById = (out: any, id: string): any =>
  out.prompts.find((p: any) => p.identifier === id)

describe('exportPresetSemantic reflects the edited state (ADR 0018 lossless export)', () => {
  it('carries content edit + reorder + disable + add + delete, not the imported bytes', () => {
    importPresetFromFile(profileId, writeTmp(synthPreset('Edited Export')))
    const id = getActivePresetId(profileId)!

    // Edit the normalized view the way the Preset Manager would: change a body, reorder two blocks,
    // disable one, add one, and delete one.
    const view = getPresetById(profileId, id)!
    const main = view.prompts.find((p) => p.identifier === 'main')!
    const lore = view.prompts.find((p) => p.identifier === 'lore')!
    const jb = view.prompts.find((p) => p.identifier === 'jailbreak')!

    main.content = 'Alpha REWRITTEN wobble as {{char}}.' // content edit
    lore.enabled = false // enablement toggle
    const edited = {
      ...view,
      prompts: [
        jb, // reorder: jailbreak now first
        main,
        // 'lore' kept (disabled); 'jailbreak' moved; add a brand-new block; DELETE nothing yet
        {
          identifier: 'custom-added',
          name: 'Added Note',
          role: 'user' as const,
          content: 'Delta crinkle the {{user}} sideways.',
          enabled: true,
          marker: 'none' as const,
          injection_depth: null,
          injection_order: 100,
          injection_trigger: [],
          forbid_overrides: false
        },
        lore
      ]
    }
    // Now DELETE 'jailbreak' from the list entirely to prove deletions are reflected too.
    edited.prompts = edited.prompts.filter((p) => p.identifier !== 'jailbreak')
    savePreset(profileId, id, edited)

    const out = JSON.parse(exportPresetSemantic(profileId, id)!)

    // Content edit reflected on the prompt DEFINITION.
    expect(promptById(out, 'main').content).toBe('Alpha REWRITTEN wobble as {{char}}.')

    // The active order reflects reorder + enablement + addition, and the deletion is gone.
    const order = orderOf(out)
    expect(order.map((e) => e.identifier)).toEqual(['main', 'custom-added', 'lore'])
    expect(order.find((e) => e.identifier === 'lore')!.enabled).toBe(false)
    expect(order.find((e) => e.identifier === 'main')!.enabled).toBe(true)
    expect(order.some((e) => e.identifier === 'jailbreak')).toBe(false) // deletion reflected

    // The added prompt has a real definition (content survives).
    expect(promptById(out, 'custom-added').content).toBe('Delta crinkle the {{user}} sideways.')

    // Losslessness: unmodeled fields still pass through.
    expect(out.quirk_top_level).toBe('the wibbling frobnitz remains')
    expect(out.extensions.custom_ns.keepme).toBe('the plum wibbles unbothered')

    // NOT the imported bytes: the original main content is gone.
    expect(JSON.stringify(out)).not.toContain('Alpha wobble as {{char}}.')
  })

  it('leaves an UNEDITED preset export JSON.parse-equal to the import (round-trip invariant intact)', () => {
    const raw = synthPreset('Unedited Export')
    importPresetFromFile(profileId, writeTmp(raw))
    const id = getActivePresetId(profileId)!
    // Re-save the view verbatim (a Preset Manager open/close with no change) — export must still equal raw.
    savePreset(profileId, id, getPresetById(profileId, id)!)
    expect(JSON.parse(exportPresetSemantic(profileId, id)!)).toEqual(raw)
  })
})
