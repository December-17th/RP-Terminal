// test/inlineHostPresetParity.test.ts
//
// Transport parity for getPreset('in_use') — the inline (cardBridge) transport is the DEFAULT, and it
// must return the SAME envelope-derived `prompts_unused` + `extensions` as the WCV transport. Both now
// bottom out in `presetService.getActivePresetView`: WCV via its sync channel (wcvIpc `preset`), the
// inline host via the `getActivePresetViewSync` sync IPC. This test imports a REAL preset envelope (with
// a defined-but-unused prompt and populated extensions), then asserts the inline host's `preset()` and
// the runtime's `getPreset('in_use')` agree with the WCV data source — guarding against the pre-fix
// regression where inline hard-returned `prompts_unused: []` / `extensions: {}`.
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

// The inline host pulls in the renderer store modules; stub them exactly like inlineHostPersona.test.ts.
vi.mock('../src/renderer/src/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ floors: [], chats: [] }), subscribe: () => () => {} }
}))
vi.mock('../src/renderer/src/stores/characterStore', () => ({
  useCharacterStore: { getState: () => ({ activeCharacter: null }) }
}))
vi.mock('../src/renderer/src/stores/presetStore', () => ({
  usePresetStore: { getState: () => ({ preset: null, presets: [], activeId: null, load: vi.fn() }) }
}))
vi.mock('../src/renderer/src/stores/regexStore', () => ({
  useRegexStore: { getState: () => ({ rules: [], apply: (text: string) => text }) }
}))
vi.mock('../src/renderer/src/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: { persona: {} } }) }
}))
vi.mock('../src/renderer/src/stores/composerStore', () => ({
  useComposerStore: { getState: () => ({}) }
}))
vi.mock('../src/renderer/src/stores/lorebookStore', () => ({
  useLorebookStore: {
    getState: () => ({ library: [], sessionLorebooks: [], loadLibrary: vi.fn(), loadSession: vi.fn() })
  }
}))
vi.mock('../src/renderer/src/cardBridge/cardHostEvents', () => ({ onCardHostEvent: vi.fn() }))
vi.mock('../src/renderer/src/cardBridge/playTheme', () => ({
  applyRuntimeTheme: vi.fn(),
  getEffectivePlayTheme: vi.fn()
}))

import { createInlineHost } from '../src/renderer/src/cardBridge/host'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'
import { importPresetFromFile, getActivePresetView } from '../src/main/services/presetService'
import { getAppDir } from '../src/main/services/storageService'
import type { Host } from '../src/shared/thRuntime/types'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
const tmpFiles: string[] = []
afterAll(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

/**
 * A synthesized ST preset (all prose is invented gibberish — clean-room). `spare` is defined in
 * `prompts[]` but omitted from the active `prompt_order`, so it lands in `prompts_unused`; `extensions`
 * carries an SPreset binding + an unknown namespace. Both are what the two transports must agree on.
 */
const synthPreset = (name: string): any => ({
  name,
  temperature: 0.6,
  openai_max_tokens: 2500,
  prompts: [
    { identifier: 'main', name: 'Main', role: 'system', content: 'Wobble as {{char}}.' },
    { identifier: 'jailbreak', name: 'Jailbreak', role: 'system', content: 'Flumph the {{user}}.' },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
    { identifier: 'spare', name: 'Spare', role: 'user', content: 'A dormant frobnitz block.' }
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: false }
      ]
    }
  ],
  extensions: {
    SPreset: { RegexBinding: { enabled: true }, flavor: 'quorm' },
    custom_namespace: { keepme: 'the plum wibbles unbothered' }
  }
})

const ctx = { profileId, chatId: 'chat-a', characterId: 'char-a' }

beforeEach(() => {
  // The inline host reads the preset view via the SAME main-side projection the WCV sync channel does —
  // this stub mirrors the `get-active-preset-view-sync` handler (presetIpc.ts) exactly.
  vi.stubGlobal('window', {
    api: { getActivePresetViewSync: (pid: string) => getActivePresetView(pid) }
  })
})

describe('getPreset transport parity — inline (cardBridge) matches WCV', () => {
  it('inline host preset() returns the envelope-derived prompts_unused + extensions (not empty)', () => {
    const file = path.join(os.tmpdir(), `rpt-parity-${randomUUID()}.json`)
    fs.writeFileSync(file, JSON.stringify(synthPreset('Parity A')), 'utf-8')
    tmpFiles.push(file)
    importPresetFromFile(profileId, file)

    // WCV data source: the exact value wcvIpc `preset` returns.
    const wcvView = getActivePresetView(profileId)!
    expect(wcvView).not.toBeNull()

    const inlineView = createInlineHost(ctx).preset()!
    expect(inlineView).not.toBeNull()

    // The regression guard: pre-fix the inline transport hard-returned [] / {} here.
    expect(inlineView.prompts_unused.map((p) => p.identifier)).toContain('spare')
    expect(Object.keys(inlineView.extensions)).toEqual(
      expect.arrayContaining(['SPreset', 'custom_namespace'])
    )

    // Parity: inline == WCV for the two envelope-backed fields.
    expect(inlineView.prompts_unused).toEqual(wcvView.prompts_unused)
    expect(inlineView.extensions).toEqual(wcvView.extensions)
  })

  it('runtime getPreset("in_use") is identical across both transports', () => {
    const file = path.join(os.tmpdir(), `rpt-parity-${randomUUID()}.json`)
    fs.writeFileSync(file, JSON.stringify(synthPreset('Parity B')), 'utf-8')
    tmpFiles.push(file)
    importPresetFromFile(profileId, file)

    // WCV host: preset() = the sync-channel value (getActivePresetView). Inline host: the real one.
    const wcvHost: Host = { ...createNullHost(ctx), preset: () => getActivePresetView(profileId) }
    const inlineRt = createThRuntime(createInlineHost(ctx)) as any
    const wcvRt = createThRuntime(wcvHost) as any

    const inlineP = inlineRt.getPreset('in_use')
    const wcvP = wcvRt.getPreset('in_use')

    expect(inlineP.prompts_unused).toEqual(wcvP.prompts_unused)
    expect(inlineP.extensions).toEqual(wcvP.extensions)
    // Full shape parity too — the shared runtime maps both identically.
    expect(inlineP).toEqual(wcvP)
  })
})
