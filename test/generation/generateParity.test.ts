import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'

// --- deterministic fixtures ------------------------------------------------
const settings = (() => {
  const s = getDefaultSettings()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'test-model' }
  s.agent = { mode: 'off' } // classic path: lore re-matched per turn, no FSM tuning
  s.memory = { ...s.memory, enabled: false } // memory covered separately; keep the base snapshot simple
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

// two prior floors so history + lastFloor are non-trivial
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

// a canned model response: reasoning + an MVU update + an rpt-event, so fold/parse run for real
const RAW = '<thinking>plan</thinking>You open the door.\n<UpdateVariable>_.set("hp", 9)</UpdateVariable>'

let capturedSend: unknown = null
let capturedFloor: FloorFile | null = null

vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({ id: 'chat1', character_id: 'card1', floor_count: 2, lorebook_ids: null }),
  getChatLorebookIds: () => null,
  getChatMode: () => 'explore',
  getCachedWorldInfo: () => null,
  setCachedWorldInfo: () => {},
  appendFloor: (_p: string, _c: string, f: FloorFile) => {
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
  matchAcross: () => [] // no lore for the base snapshot (deterministic)
}))
vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: () => floors,
  getFloor: () => floors[floors.length - 1],
  saveFloor: () => {}
}))
vi.mock('../../src/main/services/retrievalService', () => ({
  selectMemories: async () => ({ block: '', rows: [] })
}))
vi.mock('../../src/main/services/compactionService', () => ({ maybeCompact: async () => {} }))
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
  streamProvider: async (_s: unknown, messages: unknown) => {
    capturedSend = messages
    return RAW
  }
}))

import { generate } from '../../src/main/services/generationService'

describe('generate() — parity baseline', () => {
  beforeEach(() => {
    capturedSend = null
    capturedFloor = null
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-06-01T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('produces a stable sendMessages array + written floor', async () => {
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    // the two things the parity contract pins:
    expect(capturedSend).toMatchSnapshot('sendMessages')
    expect(capturedFloor).toMatchSnapshot('writtenFloor')
  })
})
