import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'
import { DEFAULT_GRAPH } from '../../src/main/services/nodes/builtin/defaultGraph'

// Proves generate() actually consumes workflowService.resolveWorkflowDoc (rather than a
// hardcoded 'default' literal + DEFAULT_GRAPH) and threads the resolved id through to
// buildTurnContext — the wiring Task 5 adds on top of Task 3 (resolver) + Task 4 (ctx arg).

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
  matchAcross: () => []
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
  streamProvider: async (
    _s: unknown,
    _messages: unknown,
    _params: unknown,
    onDelta: (d: string) => void
  ) => {
    onDelta('You open the door.')
    return 'You open the door.'
  }
}))

const { resolveWorkflowDoc, buildTurnContext } = vi.hoisted(() => ({
  resolveWorkflowDoc: vi.fn(),
  buildTurnContext: vi.fn()
}))
vi.mock('../../src/main/services/workflowService', () => ({ resolveWorkflowDoc }))
vi.mock('../../src/main/services/nodes/turnContext', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  buildTurnContext.mockImplementation((actual as any).buildTurnContext)
  return { ...actual, buildTurnContext }
})

import { generate } from '../../src/main/services/generationService'

describe('generate() — resolves the active workflow', () => {
  beforeEach(() => {
    capturedFloor = null
    appendFloorCalled = false
    resolveWorkflowDoc.mockReset().mockReturnValue({ id: 'custom-1', doc: DEFAULT_GRAPH })
    buildTurnContext.mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-06-01T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('calls resolveWorkflowDoc(profileId, chatId) and threads its id into buildTurnContext', async () => {
    const floor = await generate('profile1', 'chat1', 'open the door')

    expect(resolveWorkflowDoc).toHaveBeenCalledWith('profile1', 'chat1')
    expect(buildTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'custom-1' })
    )
    expect(floor).not.toBeNull()
    expect(appendFloorCalled).toBe(true)
    expect(capturedFloor).not.toBeNull()
  })
})
