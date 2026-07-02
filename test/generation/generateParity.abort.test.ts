import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'
import type { LorebookEntry } from '../../src/main/types/character'

// Expanded parity coverage (Phase 2b-1b abort fix): runs the REAL DEFAULT_GRAPH through
// generate(), with a per-test-configurable streamProvider/matchAcross mock, to assert:
//  - abort-with-text persists the partial floor (the bug this task fixes)
//  - abort-with-empty still returns null / doesn't persist (unchanged behavior)
//  - lore flows through the graph into the assembled prompt
//  - a combat-start cue folds onto the persisted floor's variables
// Kept in a SEPARATE file (rather than extending generateParity.test.ts) because these cases
// need per-test scenario switching, which doesn't mix well with that file's single fixed
// module-level streamProvider/matchAcross mocks used for the byte-identical snapshot.

const settings = (() => {
  const s = getDefaultSettings()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'test-model' }
  s.agent = { mode: 'off' }
  s.memory = { ...s.memory, enabled: false }
  return s
})()

const preset = getDefaultPreset()

const card = {
  id: 'card1',
  data: {
    name: 'Testchar',
    description: 'A calm guide.',
    personality: 'patient',
    scenario: 'a quiet room',
    first_mes: 'Hello.',
    extensions: {}
  }
} as any

const floors: FloorFile[] = [
  {
    floor: 0,
    chat_id: 'chat1',
    timestamp: '2020-01-01T00:00:00.000Z',
    user_message: { content: '', timestamp: '2020-01-01T00:00:00.000Z' },
    response: { content: 'Hello.', model: 'test-model', provider: 'openai' },
    events: [],
    variables: { stat_data: { hp: 10 } }
  },
  {
    floor: 1,
    chat_id: 'chat1',
    timestamp: '2020-01-01T00:01:00.000Z',
    user_message: { content: 'look around', timestamp: '2020-01-01T00:01:00.000Z' },
    response: { content: 'You see a door.', model: 'test-model', provider: 'openai' },
    events: [],
    variables: { stat_data: { hp: 10 } }
  }
]

// --- per-test mutable scenario, read by the streamProvider/matchAcross mocks below ---
type Scenario = {
  /** What streamProvider does: 'text' streams RAW and returns it normally; 'abort-text' streams
   *  a partial via onDelta, aborts the chat's controller, then RETURNS the partial (mirrors
   *  streamProvider's real "user stopped — keep whatever streamed" behavior); 'abort-empty'
   *  aborts then returns ''; 'fail' throws (network/auth/429-exhausted — a real provider
   *  failure, NOT a user stop). */
  mode: 'text' | 'abort-text' | 'abort-empty' | 'fail'
  raw: string
  lore: LorebookEntry[]
}
let scenario: Scenario = { mode: 'text', raw: 'You open the door.', lore: [] }

let capturedSend: unknown = null
let capturedFloor: FloorFile | null = null
let appendFloorCalled = false

vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({ id: 'chat1', character_id: 'card1', floor_count: 2, lorebook_ids: null }),
  getChatLorebookIds: () => null,
  getChatMode: () => 'explore',
  getChatWorkflowId: () => null,
  getCachedWorldInfo: () => null,
  setCachedWorldInfo: () => {},
  appendFloor: (_p: string, _c: string, f: FloorFile) => {
    appendFloorCalled = true
    capturedFloor = f
  },
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
vi.mock('../../src/main/services/lorebookService', () => ({
  getLorebookById: () => ({ id: 'card1', name: 'lb', entries: [] }),
  matchAcross: () => scenario.lore
}))
vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: () => floors,
  getFloor: () => floors[floors.length - 1],
  saveFloor: () => {}
}))
vi.mock('../../src/main/services/retrievalService', () => ({
  selectMemories: async () => ({ block: '', rows: [] })
}))
vi.mock('../../src/main/services/compactionService', () => ({
  maybeCompact: async () => {},
  // The decomposed D5 memory nodes read these stage fns; memory is disabled in these tests,
  // so the gate never finds a due batch.
  tryBeginCompaction: () => true,
  endCompaction: () => {},
  compactionDue: () => null
}))
vi.mock('../../src/main/services/memoryEvents', () => ({ notifyMemoryRecalled: () => {} }))
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({}),
  saveGlobals: () => {}
}))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))
vi.mock('../../src/main/services/apiService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  streamProvider: async (
    _s: unknown,
    messages: unknown,
    _params: unknown,
    onDelta: (d: string) => void
  ) => {
    capturedSend = messages
    if (scenario.mode === 'text') {
      onDelta(scenario.raw)
      return scenario.raw
    }
    if (scenario.mode === 'abort-text') {
      onDelta(scenario.raw)
      abortGeneration('chat1')
      return scenario.raw
    }
    if (scenario.mode === 'fail') {
      throw new Error('provider down: 503')
    }
    // abort-empty
    abortGeneration('chat1')
    return ''
  }
}))

import { generate, abortGeneration } from '../../src/main/services/generationService'

describe('generate() — expanded parity (abort + lore + combat)', () => {
  beforeEach(() => {
    capturedSend = null
    capturedFloor = null
    appendFloorCalled = false
    scenario = { mode: 'text', raw: 'You open the door.', lore: [] }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-06-01T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('abort-with-text: persists a non-null floor whose response.content is the partial', async () => {
    scenario = {
      mode: 'abort-text',
      raw: 'You open the door and freez',
      lore: []
    }
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    expect(floor!.response.content).toBe(scenario.raw)
    expect(appendFloorCalled).toBe(true)
    expect(capturedFloor).not.toBeNull()
    expect(capturedFloor!.response.content).toBe(scenario.raw)
  })

  it('abort-with-empty: returns null and does not persist a floor', async () => {
    scenario = { mode: 'abort-empty', raw: '', lore: [] }
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).toBeNull()
    expect(appendFloorCalled).toBe(false)
    expect(capturedFloor).toBeNull()
  })

  it('provider failure: generate() REJECTS with the provider error (not a silent null)', async () => {
    // Pre-workflow behavior: callModel rethrew a non-abort provider error and generate()
    // propagated it, so the renderer showed its error banner (chatStore catch). The graph
    // engine converts the throw into a pre-phase fatal RESULT — generate() must re-surface
    // it as a rejection (spec §10: unwired + failed ⇒ turn aborts with the error surfaced),
    // or a hard failure reads exactly like a user Stop.
    scenario = { mode: 'fail', raw: '', lore: [] }
    await expect(generate('profile1', 'chat1', 'open the door')).rejects.toThrow(
      'provider down: 503'
    )
    expect(appendFloorCalled).toBe(false)
    expect(capturedFloor).toBeNull()
  })

  it('lore non-empty: matched lorebook content flows into the assembled sendMessages', async () => {
    scenario = {
      mode: 'text',
      raw: 'You open the door.',
      lore: [
        {
          keys: ['door'],
          secondary_keys: [],
          content: 'LORE-X',
          enabled: true,
          insertion_order: 100,
          insertion_depth: null,
          case_sensitive: false,
          constant: true,
          selective: false,
          probability: 100,
          exclude_recursion: false,
          prevent_recursion: false,
          comment: 'lore entry'
        }
      ]
    }
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    const sendJson = JSON.stringify(capturedSend)
    expect(sendJson).toContain('LORE-X')
  })

  it('combat cue: an <rpt-combat-start> tag in the raw sets variables.combat_cue on the persisted floor', async () => {
    scenario = {
      mode: 'text',
      raw: 'The bandits attack!<rpt-combat-start enemies="Bandit x2" map="road"></rpt-combat-start>',
      lore: []
    }
    const floor = await generate('profile1', 'chat1', 'walk down the road')
    expect(floor).not.toBeNull()
    expect(floor!.variables.combat_cue).toBeTruthy()
    expect((floor!.variables.combat_cue as any).enemies).toBe('Bandit x2')
    expect((floor!.variables.combat_cue as any).map).toBe('road')
  })
})
