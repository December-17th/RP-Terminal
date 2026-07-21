import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'

// --- deterministic fixtures ------------------------------------------------
const settings = (() => {
  const s = getDefaultSettings()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'test-model' }
  s.agent = { mode: 'off' } // classic path: lore re-matched per turn, no FSM tuning
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
const RAW =
  '<thinking>plan</thinking>You open the door.\n<UpdateVariable>_.set("hp", 9)</UpdateVariable>'

let capturedSend: unknown = null
let capturedParams: any = null
let capturedFloor: FloorFile | null = null
let capturedSavedFloor: FloorFile | null = null
let capturedTruncations: number[] = []

const generationCalls = vi.hoisted(
  () => [] as Array<{ userAction: string | undefined; generationType: string | undefined }>
)

// Yuzu is a presentation/post-processing toggle; primary narration stays byte-identical to Classic.
const yuzuFlag = vi.hoisted(() => ({ on: false }))

// Hoisted provider controller so tests can script exact replies. `queue` is drained one reply per
// streamProvider call; when empty the mock returns the normal Classic response.
const provider = vi.hoisted(() => ({
  queue: [] as string[],
  calls: 0,
  defaultResponse:
    '<thinking>plan</thinking>You open the door.\n<UpdateVariable>_.set("hp", 9)</UpdateVariable>'
}))

vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({ id: 'chat1', character_id: 'card1', floor_count: 2, lorebook_ids: null }),
  getChatLorebookIds: () => null,
  getChatMode: () => 'explore',
  isYuzuMode: () => yuzuFlag.on,
  // M5a: generate() is now single-path direct, which always runs the table-export stage — it reads
  // getChatTableTemplateId (null ⇒ no table memory, empty projection). NARRATOR_SPINE_DOC has no
  // table.export node, so the pre-M5a workflow path never reached this; the direct path always does.
  getChatTableTemplateId: () => null,
  getChatWorkflowId: () => null,
  getCachedWorldInfo: () => null,
  setCachedWorldInfo: () => {},
  appendFloor: (_p: string, _c: string, f: FloorFile) => {
    capturedFloor = f
  },
  truncateFloors: (_p: string, _c: string, fromFloor: number) => {
    capturedTruncations.push(fromFloor)
  }
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
  getFloorRequest: () => undefined,
  getFloorCount: () => floors.length,
  saveFloor: (_p: string, _c: string, f: FloorFile) => {
    capturedSavedFloor = f
  }
}))
// M5c-1: generate() no longer builds a node RunContext — the direct path threads userAction +
// generationType straight into `buildGenContext`. Capture the forwarded pair there instead.
vi.mock('../../src/main/services/generation/genContext', async (orig) => {
  const actual = await orig<typeof import('../../src/main/services/generation/genContext')>()
  return {
    ...actual,
    buildGenContext: (
      profileId: string,
      chatId: string,
      userAction: string,
      generationType?: string
    ) => {
      generationCalls.push({ userAction, generationType })
      return actual.buildGenContext(profileId, chatId, userAction, generationType)
    }
  }
})
vi.mock('../../src/main/services/regexService', () => ({
  getPromptRules: () => [],
  getWorldInfoRules: () => []
}))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({}),
  saveGlobals: () => {}
}))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))
// M5c-2: generate() no longer resolves a workflow doc — the direct path runs the fixed Classic spine
// against the mocked chat/card/settings above, so no workflowService mock is needed.
vi.mock('../../src/main/services/apiService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  streamProvider: async (_s: unknown, messages: unknown, params: unknown) => {
    provider.calls++
    capturedSend = messages
    capturedParams = params
    if (provider.queue.length) return provider.queue.shift()!
    return provider.defaultResponse
  }
}))

import { generate, generateSwipe, regenerate } from '../../src/main/services/generationService'

describe('generate() — parity baseline', () => {
  beforeEach(() => {
    capturedSend = null
    capturedParams = null
    capturedFloor = null
    capturedSavedFloor = null
    capturedTruncations = []
    generationCalls.length = 0
    delete floors[1].swipes
    delete floors[1].swipe_id
    yuzuFlag.on = false
    provider.queue = []
    provider.calls = 0
    settings.yuzu = { max_tokens: 30000 } // reset any per-test override to the default
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

  it('regenerate truncates the latest floor and replays its action with generation type regenerate', async () => {
    const floor = await regenerate('profile1', 'chat1')

    expect(capturedTruncations).toEqual([1])
    expect(generationCalls).toEqual([{ userAction: 'look around', generationType: 'regenerate' }])
    expect(floor?.user_message.content).toBe('look around')
  })

  it('generateSwipe preserves prior alternates, appends the reroll, and marks it active', async () => {
    floors[1].swipes = ['A first look.', 'You see a door.']
    floors[1].swipe_id = 1

    const floor = await generateSwipe('profile1', 'chat1')

    expect(capturedTruncations).toEqual([1])
    expect(generationCalls).toEqual([{ userAction: 'look around', generationType: 'swipe' }])
    expect(floor?.swipes).toEqual(['A first look.', 'You see a door.', RAW])
    expect(floor?.swipe_id).toBe(2)
    expect(capturedSavedFloor).toBe(floor)
  })

  it('VN mode keeps the Classic narrator prompt, preset budget, and one primary provider call', async () => {
    await generate('profile1', 'chat1', 'open the door')
    const classicSend = structuredClone(capturedSend)
    const classicParams = structuredClone(capturedParams)

    yuzuFlag.on = true
    settings.yuzu = { max_tokens: 8000 }
    provider.calls = 0
    const floor = await generate('profile1', 'chat1', 'open the door')

    expect(floor).not.toBeNull()
    expect(capturedSend).toEqual(classicSend)
    expect(capturedParams).toEqual(classicParams)
    expect((capturedParams as { max_tokens: number }).max_tokens).toBe(preset.parameters.max_tokens)
    expect(provider.calls).toBe(1)
    expect(capturedFloor!.response.content).toBe(RAW)
    expect(capturedFloor!.yuzu_trace).toBeUndefined()
  })

  it('classic floors carry NO yuzu_trace (VN-only field)', async () => {
    // yuzuFlag stays off — a plain classic turn must never write the gate trace.
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    expect(capturedFloor!.yuzu_trace).toBeUndefined()
    expect(provider.calls).toBe(1) // classic: exactly one model call, no gate re-ask
  })
})
