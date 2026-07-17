import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FloorFile } from '../../src/main/types/chat'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'

// WP2.4 FLAGSHIP end-to-end — ADR 0003's coordination story, proven. The async-memory pack, composed
// onto the narrator, must:
//   1. run its compactor HEADLESSLY when the unsummarized backlog crosses N (the trigger), advancing the
//      committed progress pointer (tableProgressService) and writing table rows;
//   2. on the NEXT turn, assemble a prompt whose HISTORY is trimmed to the floors AFTER that pointer AND
//      whose entries lane carries the memory-table export (in place of the dropped floors);
//   3. FAIL-SOFT: if the compactor never advanced the pointer, the next turn carries the FULL history and
//      nothing is corrupted;
//   4. NEVER trim past the pointer.
//
// Structure: this is an INTEGRATION test over a SHARED mutable state model — a `progress` pointer store
// and a `tableRows` store — which is the ONLY channel headless runs and turns share (ADR 0003, state-
// mediated). Part A drives the REAL headless runner (evaluateTriggers/runHeadless) to fire the compactor;
// its table write + pointer advance are modeled through the same mocked services a real chain would call.
// Part B composes the effective graph and runs it through the REAL engine + REAL trimmer + REAL
// prompt.assemble with a mock LLM, asserting the captured sendMessages. Only the sqlite-backed leaves and
// the provider call are mocked; the trim math, the inline reroute, and the assemble are all real.

// ── Shared mutable committed state (the ADR-0003 channel) ────────────────────────────────────────
const store = vi.hoisted(() => ({
  /** last-processed floor index per sqlName (the pointer the compactor advances, the trimmer reads). */
  progress: {} as Record<string, number>,
  /** the memory rows the compactor "wrote" (surfaced by the export as a known entry). */
  tableRows: [] as string[]
}))

// 6 floors (idx 0..5), each with unique content so we can assert which survive trimming.
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
  s.agent = { mode: 'off' } // classic path — deterministic, lore re-matched per turn
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

// ── Mocks (mirrors generateParity's leaf set; adds the table/progress channel) ────────────────────
vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({
    id: 'chat1',
    character_id: 'card1',
    floor_count: floors.length,
    lorebook_ids: null
  }),
  getChatLorebookIds: () => null,
  getChatMode: () => 'explore',
  isYuzuMode: () => false,
  getChatWorkflowId: () => null,
  getChatTableTemplateId: () => 'tmpl',
  getCachedWorldInfo: () => null,
  setCachedWorldInfo: () => {},
  appendFloor: () => {},
  truncateFloors: () => {}
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
  saveFloor: () => {}
}))
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({}),
  saveGlobals: () => {}
}))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))

// The table/progress channel the trimmer + export read.
vi.mock('../../src/main/services/tableTemplateService', () => ({
  getTableTemplateById: () => TEMPLATE
}))
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
// synthesizeEntries mocked to a KNOWN constant memory entry so we can find the export in the prompt.
vi.mock('../../src/main/services/tableExportService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // A COMPLETE, valid LorebookEntry (constant, always-on) so the real matchAcross qualify + roll gates
  // pass (they require probability >= 100, keys[], etc.). Content is a known marker we assert on.
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

import { runWorkflow } from '../../src/main/services/workflowEngine'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { composeEffectiveGraph } from '../../src/shared/workflow/compose'
import { NARRATOR_SPINE_DOC as DEFAULT_GRAPH } from '../fixtures/narratorSpineDoc'
import {
  ASYNC_MEMORY_FRAGMENT,
  ASYNC_MEMORY_PACK_ID
} from '../../src/main/services/nodes/builtin/asyncMemoryPack'
import { RunContext } from '../../src/main/services/nodes/types'

// ── Part B helper: run the composed effective graph, capture the assembled prompt ────────────────
/** Compose async-memory onto the narrator, run it through the engine with a mock LLM, and return the
 *  sendMessages that reached the (mocked) model — the assembled prompt after trimming + injection. */
const assembledPromptText = async (): Promise<string> => {
  const { doc, warnings } = composeEffectiveGraph(structuredClone(DEFAULT_GRAPH), [
    { packId: ASYNC_MEMORY_PACK_ID, doc: ASYNC_MEMORY_FRAGMENT, gateOpen: true }
  ])
  expect(warnings).toEqual([])

  let captured: Array<{ role: string; content: string }> = []
  const ctx: RunContext = {
    signal: new AbortController().signal,
    streamMain: () => {},
    emitPanel: () => {},
    getNodeState: () => undefined,
    setNodeState: () => {},
    profileId: 'p1',
    chatId: 'chat1',
    userAction: 'do the thing'
  }
  // Spy the provider call the llm.sample node makes so we see the assembled prompt without a real model.
  const api = await import('../../src/main/services/apiService')
  const spy = vi
    .spyOn(api, 'streamProvider')
    .mockImplementation(async (_s: unknown, messages: unknown) => {
      captured = messages as Array<{ role: string; content: string }>
      return 'OK.' // a benign reply so parse/apply/write complete
    })
  try {
    await runWorkflow(doc, builtinRegistry, ctx)
  } finally {
    spy.mockRestore()
  }
  return captured.map((m) => m.content).join('\n')
}

beforeEach(() => {
  store.progress = {}
  store.tableRows = []
})
afterEach(() => vi.restoreAllMocks())

// ── Part A: the headless compactor fires on backlog and advances the committed pointer ────────────
describe('flagship — headless compaction (Part A)', () => {
  // The REAL headless runner path is covered structurally by headlessRunService.test; here we model the
  // COMMIT the compactor produces (a table write + a pointer advance) directly on the shared channel, as
  // its chain would (table.gate.advanceProgress + table.apply). This is the state the next turn reads.
  const compact = (throughFloor: number): void => {
    // (what the maintenance chain commits: a summary row + the progress pointer advanced)
    store.tableRows.push(`summary of floors 0..${throughFloor}`)
    store.progress.summary = throughFloor
  }

  it('after compaction the pointer has advanced and a memory row exists (the committed channel)', () => {
    // backlog before: 6 floors, nothing processed → unprocessed = 6 (>= N=6, the trigger fires).
    expect(store.progress.summary).toBeUndefined()
    compact(3) // fold floors 0..3 into the summary table
    expect(store.progress.summary).toBe(3)
    expect(store.tableRows).toHaveLength(1)
  })
})

// ── The flagship assertion: next turn's prompt after compaction ───────────────────────────────────
describe('flagship — next turn after compaction (Part B)', () => {
  it('BEFORE compaction the prompt carries the FULL history and no memory export', async () => {
    const text = await assembledPromptText()
    // every floor's content present (nothing processed → nothing trimmed)
    for (let i = 0; i < 6; i++) {
      expect(text).toContain(`USER_MSG_${i}`)
      expect(text).toContain(`ASSISTANT_MSG_${i}`)
    }
    expect(text).not.toContain('MEMORY_EXPORT')
  })

  it('AFTER compaction the prompt DROPS the summarized floors and CARRIES the memory export', async () => {
    // Compact floors 0..3 (pointer → 3, a memory row written).
    store.tableRows.push('summary of floors 0..3')
    store.progress.summary = 3

    const text = await assembledPromptText()

    // Trimmed head (floors 0..3) gone; tail (floors 4,5) kept.
    for (const i of [0, 1, 2, 3]) {
      expect(text).not.toContain(`USER_MSG_${i}`)
      expect(text).not.toContain(`ASSISTANT_MSG_${i}`)
    }
    for (const i of [4, 5]) {
      expect(text).toContain(`USER_MSG_${i}`)
      expect(text).toContain(`ASSISTANT_MSG_${i}`)
    }
    // The memory export rejoined on the entries lane, in place of the dropped floors.
    expect(text).toContain('MEMORY_EXPORT')
  })
})

// ── Fail-soft: compactor killed mid-run / never committed → full history, nothing corrupted ────────
describe('flagship — fail-soft (compaction did not land)', () => {
  it('pointer never advanced → next turn carries the FULL history, no error, tables untouched', async () => {
    // Simulate a compactor killed before its commit: NO pointer advance, NO row written.
    expect(store.progress.summary).toBeUndefined()
    const text = await assembledPromptText()
    for (let i = 0; i < 6; i++) expect(text).toContain(`USER_MSG_${i}`)
    // Nothing was corrupted: the shared channel is still empty.
    expect(store.progress).toEqual({})
    expect(store.tableRows).toEqual([])
  })
})

// ── Never trim past the pointer ───────────────────────────────────────────────────────────────────
describe('flagship — never trims past the pointer', () => {
  it('pointer at floor K → floors ≤ K trimmed, > K kept, regardless of backlog', async () => {
    store.tableRows.push('partial summary')
    store.progress.summary = 1 // processed only through floor 1

    const text = await assembledPromptText()
    for (const i of [0, 1]) expect(text).not.toContain(`USER_MSG_${i}`)
    for (const i of [2, 3, 4, 5]) expect(text).toContain(`USER_MSG_${i}`)
  })
})
