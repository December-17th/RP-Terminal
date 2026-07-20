import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FloorFile } from '../../src/main/types/chat'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'

// The next-prompt injection preview service. As of execution-plan M5b the preview runs the SAME pre-LLM
// stages the direct Classic path runs (buildGenContext → trimProcessedContext → exportTableEntries →
// matchWorldInfo + assemblePrompt) with NO engine, NO packs, and NO provider call. Asserts:
//   1. sections are shaped from the assembler's Execution Record (card / history / action surface);
//   2. the SQL-table export lands as a world-info section when a memory row exists (the fixed spine's
//      only "injection" — export → assemble.entries);
//   3. ZERO state writes (before/after snapshots of the shared floor-vars + table-progress channel);
//   4. ZERO LLM calls (streamProvider spied and asserted never called).

const store = vi.hoisted(() => ({
  progress: {} as Record<string, number>,
  tableRows: [] as string[],
  /** every floor's variables, so we can prove the preview never wrote one. */
  savedFloors: [] as unknown[]
}))

const floors: FloorFile[] = Array.from({ length: 6 }, (_, i) => ({
  floor: i,
  chat_id: 'chat1',
  timestamp: '2020-01-01T00:00:00.000Z',
  user_message: { content: `USER_MSG_${i}`, timestamp: '2020-01-01T00:00:00.000Z' },
  response: { content: `ASSISTANT_MSG_${i}`, model: 'm', provider: 'openai' },
  events: [],
  variables: { stat_data: { hp: 10 } }
}))

const settings = (() => {
  const s = getDefaultSettings()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'test-model' }
  s.agent = { mode: 'off' }
  return s
})()
const preset = getDefaultPreset()
const card = {
  id: 'card1',
  data: {
    name: 'Testchar',
    description: 'A guide.',
    personality: 'calm',
    scenario: 'a room',
    first_mes: 'Hi.',
    extensions: {}
  }
} as unknown

const TEMPLATE = {
  id: 'tmpl',
  tables: [{ sqlName: 'summary', displayName: '纪要', headers: ['t'], updateFrequency: 1 }]
}

const chatHolder = vi.hoisted(() => ({
  chat: { id: 'chat1', character_id: 'card1', floor_count: 6, lorebook_ids: null } as unknown
}))
vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => chatHolder.chat,
  getChatLorebookIds: () => null,
  getChatMode: () => 'explore',
  isYuzuMode: () => false,
  getChatWorkflowId: () => null,
  getChatTableTemplateId: () => 'tmpl',
  getCachedWorldInfo: () => null,
  setCachedWorldInfo: () => {}
}))
vi.mock('../../src/main/services/characterService', () => ({ getCharacter: () => card }))
vi.mock('../../src/main/services/settingsService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSettings: () => settings
}))
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => preset,
  getActivePresetId: () => 'preset1'
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLorebookById: () => ({ id: 'card1', name: 'lb', entries: [] })
}))
vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: () => floors,
  getFloorCount: () => floors.length,
  getFloorRequest: () => undefined,
  getFloor: (_p: string, _c: string, i: number) => floors[i],
  // If the preview ever wrote a floor this would record it — asserted empty (zero writes).
  saveFloor: (_p: string, _c: string, f: unknown) => store.savedFloors.push(f)
}))
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [], getWorldInfoRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({}),
  saveGlobals: () => {}
}))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))
vi.mock('../../src/main/services/tableTemplateService', () => ({ getTableTemplateById: () => TEMPLATE }))
vi.mock('../../src/main/services/tableProgressService', () => ({
  getProgress: () => ({ ...store.progress }),
  advanceProgress: (_p: string, _c: string, names: string[], floor: number) => {
    for (const n of names) store.progress[n] = Math.max(store.progress[n] ?? -1, floor)
  }
}))
vi.mock('../../src/main/services/tableDbService', () => ({
  readAllTables: () => [
    {
      sqlName: 'summary',
      displayName: '纪要',
      columns: ['t'],
      rows: store.tableRows.map((r) => [r]),
      rowids: store.tableRows.map((_, i) => i)
    }
  ]
}))
vi.mock('../../src/main/services/tableExportService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  synthesizeEntries: () =>
    store.tableRows.length
      ? [
          {
            uid: 1,
            comment: 'memory',
            content: `MEMORY_EXPORT[${store.tableRows.join(';')}]`,
            keys: [],
            secondary_keys: [],
            selective: false,
            case_sensitive: false,
            constant: true,
            enabled: true,
            probability: 100,
            insertion_order: 100,
            insertion_depth: null
          }
        ]
      : []
}))

import { previewNextPrompt } from '../../src/main/services/generation/previewService'
import * as apiService from '../../src/main/services/apiService'

beforeEach(() => {
  store.progress = {}
  store.tableRows = []
  store.savedFloors = []
  chatHolder.chat = { id: 'chat1', character_id: 'card1', floor_count: 6, lorebook_ids: null }
})
afterEach(() => vi.restoreAllMocks())

describe('previewNextPrompt — sections + attribution', () => {
  it('runs the fixed spine with zero LLM and surfaces the SQL-table export as a world-info section', async () => {
    // A committed memory row → the export projects it as a constant entry → it rejoins on assemble.entries.
    store.tableRows.push('summary of floors 0..3')
    store.progress.summary = 3
    const spy = vi.spyOn(apiService, 'streamProvider')

    const preview = await previewNextPrompt({
      profileId: 'p1',
      chatId: 'chat1',
      userAction: 'do the thing'
    })

    expect(preview.error).toBeUndefined()
    expect(preview.sections.length).toBeGreaterThan(0)
    // The table export lands as a world-info section (a lorebook-entry source in the record), NOT a pack.
    const worldInfo = preview.sections.filter((s) => s.id === 'worldInfo')
    const exportSection = worldInfo.find((s) => s.text.includes('MEMORY_EXPORT'))
    expect(exportSection).toBeDefined()
    expect(exportSection!.source.kind).toBe('narrator')
    expect(exportSection!.tokens).toBeGreaterThan(0)
    expect(exportSection!.estimated).toBe(true)
    // No pack attribution anywhere — the fixed spine has no packs.
    expect(preview.sections.some((s) => s.source.kind === 'pack')).toBe(false)
    // Zero LLM calls — the provider was never invoked.
    expect(spy).not.toHaveBeenCalled()
  })

  it('the trailing user action is its own narrator action section', async () => {
    const preview = await previewNextPrompt({
      profileId: 'p1',
      chatId: 'chat1',
      userAction: 'ATTACK the dragon'
    })
    const action = preview.sections.find((s) => s.id === 'action')
    expect(action).toBeDefined()
    expect(action!.source.kind).toBe('narrator')
    expect(action!.text).toContain('ATTACK the dragon')
  })
})

describe('previewNextPrompt — HARD: zero state writes + zero LLM', () => {
  it('preview causes zero writes to the shared floor/table channel and never calls the provider', async () => {
    store.tableRows.push('summary of floors 0..3')
    store.progress.summary = 3
    const before = {
      progress: JSON.stringify(store.progress),
      tableRows: JSON.stringify(store.tableRows),
      savedFloors: store.savedFloors.length
    }
    const spy = vi.spyOn(apiService, 'streamProvider')

    await previewNextPrompt({ profileId: 'p1', chatId: 'chat1', userAction: 'do the thing' })

    expect(JSON.stringify(store.progress)).toBe(before.progress)
    expect(JSON.stringify(store.tableRows)).toBe(before.tableRows)
    expect(store.savedFloors.length).toBe(before.savedFloors)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('previewNextPrompt — resilience', () => {
  it('resolves without throwing and carries a numeric generatedAt on the happy path', async () => {
    const preview = await previewNextPrompt({ profileId: 'p1', chatId: 'chat1', userAction: '' })
    expect(preview.error).toBeUndefined()
    expect(preview.sections.length).toBeGreaterThan(0)
    expect(typeof preview.generatedAt).toBe('number')
  })

  it('resolves error:no-chat (never throws) when the chat cannot be resolved', async () => {
    chatHolder.chat = null
    const preview = await previewNextPrompt({ profileId: 'p1', chatId: 'missing', userAction: '' })
    // buildGenContext throws on a missing chat → surfaced as a non-throwing error payload.
    expect(preview.error).toBe('no-chat')
    expect(preview.sections).toEqual([])
    expect(typeof preview.generatedAt).toBe('number')
  })
})
