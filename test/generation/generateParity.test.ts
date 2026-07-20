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

// Project Yuzu WP-S1: a hoisted toggle so the SAME mocked module serves both the classic baseline
// (off → byte-identical) and the VN-mode case (on → overlay + raised ceiling). Off by default.
const yuzuFlag = vi.hoisted(() => ({ on: false }))

// Project Yuzu WP-S2: a hoisted provider controller so a VN test can script the exact reply(s) the
// acceptance gate sees (sample, then repair). `queue` is drained one reply per streamProvider call; when
// empty the mock defaults to a byte-clean valid scene in VN mode (so the S1 overlay tests still make ONE
// sample call, not a sample+repair), and to the classic RAW when VN mode is off. `calls` counts calls.
const provider = vi.hoisted(() => ({
  queue: [] as string[],
  calls: 0,
  // A minimal scene valid against FIXTURE_INDEX (classroom location, kaede actor).
  validScene: '<| bg classroom |>\nkaede: Hello there.\n<| end |>'
}))

// A fixture asset index for the VN-mode case (kaede/yuzu sprites + moods, two backgrounds, one CG). Only
// read when yuzu mode is on (buildVnOverlay → getIndex); the classic baseline never touches it, so mocking
// worldAssetService here cannot perturb the baseline snapshots.
const FIXTURE_INDEX = {
  character: {
    kaede: { 立绘: { moods: { neutral: 'a.png', smile: 'b.png' } } },
    yuzu: { 立绘: { moods: { neutral: 'c.png' } } }
  },
  location: { classroom: { 背景: { moods: {} } }, rooftop: { 背景: { moods: {} } } },
  cg: { cg_confession: { CG: { moods: {} } } }
}
vi.mock('../../src/main/services/worldAssetService', () => ({ getIndex: () => FIXTURE_INDEX }))

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
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [], getWorldInfoRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({}),
  saveGlobals: () => {}
}))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))
// Pin resolution to the plain narrator spine fixture (the parity baseline pins narrator behavior). The
// builtin fallback is now the SQL-table memory doc, whose in-turn recall nodes (trim/export) reach for
// chatService.getChatTableTemplateId — not mocked here — and whose memory group would fire on the
// detached post-turn trigger pass. resolveEffectiveDoc returns the narrator directly (no packs here).
vi.mock('../../src/main/services/workflowService', async () => {
  const { NARRATOR_SPINE_DOC } = await import('../fixtures/narratorSpineDoc')
  return {
    BUILTIN_WORKFLOW_ID: 'default',
    resolveEffectiveDoc: () => ({ id: 'default', doc: NARRATOR_SPINE_DOC, warnings: [] }),
    setEnabledFragmentsProvider: () => {}
  }
})
vi.mock('../../src/main/services/apiService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  streamProvider: async (_s: unknown, messages: unknown, params: unknown) => {
    provider.calls++
    capturedSend = messages
    capturedParams = params
    if (provider.queue.length) return provider.queue.shift()!
    return yuzuFlag.on ? provider.validScene : RAW
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
    expect(generationCalls).toEqual([
      { userAction: 'look around', generationType: 'regenerate' }
    ])
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

  // Project Yuzu WP-S1: VN mode on. The classic pipeline gains ONE extra system block (the YSS overlay)
  // immediately before the user action, and the output ceiling is raised — nothing else changes.
  it('VN mode appends the YSS overlay before the action + raises max_tokens', async () => {
    yuzuFlag.on = true
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()

    const msgs = capturedSend as Array<{ role: string; content: string }>
    // The final message is the user action; the overlay is the system block immediately before it.
    const userIdx = msgs.length - 1
    expect(msgs[userIdx].role).toBe('user')
    const overlay = msgs[userIdx - 1]
    expect(overlay.role).toBe('system')
    // Framing + grammar + concrete vocab (deterministic, sorted) all present in the one block.
    expect(overlay.content).toContain('visual novel')
    expect(overlay.content).toContain('Yuzu Scene Script')
    expect(overlay.content).toContain('kaede, yuzu') // actors, sorted
    expect(overlay.content).toContain('neutral, smile') // union of moods, sorted
    expect(overlay.content).toContain('classroom, rooftop') // locations, sorted
    expect(overlay.content).toContain('cg_confession') // cgs
    // The VN-mode setting REPLACES the preset ceiling (preset default is 4000); default = 30000.
    expect((capturedParams as { max_tokens: number }).max_tokens).toBe(30000)
    // Pin the whole overlay block + position so any drift in content/order is caught.
    expect(overlay.content).toMatchSnapshot('vnOverlayBlock')
    expect(msgs.length).toBe((capturedSend as unknown[]).length)
  })

  // Project Yuzu WP-S1 follow-up: the player-adjusted setting reaches the provider verbatim — it
  // replaces the preset's max_tokens (even when LOWER than the preset's 4000).
  it('VN mode sends the custom settings.yuzu.max_tokens verbatim', async () => {
    yuzuFlag.on = true
    settings.yuzu = { max_tokens: 8000 }
    await generate('profile1', 'chat1', 'open the door')
    expect((capturedParams as { max_tokens: number }).max_tokens).toBe(8000)

    settings.yuzu = { max_tokens: 2000 } // below the preset's 4000 — still verbatim
    await generate('profile1', 'chat1', 'open the door')
    expect((capturedParams as { max_tokens: number }).max_tokens).toBe(2000)
  })

  // Project Yuzu WP-S2 (ADR 0009): the acceptance gate. These pin that a VN turn runs the WP-B ladder on
  // the reply BEFORE the floor commits, folds the scene's `<| effect |>` effects into canonical stat_data,
  // and persists a trace — while classic floors stay byte-identical (no gate, no trace).

  it('VN mode: a valid scene folds its <| effect |> into the floor stat_data', async () => {
    yuzuFlag.on = true
    // A valid scene whose beat carries an MVU effect: hp starts at 10 (lastFloor), the effect sets it to 42.
    provider.queue = ['<| bg classroom |>\nkaede: I feel closer to you.\n<| effect _.set(\'hp\', 42) //bonded |>\n<| end |>']
    const floor = await generate('profile1', 'chat1', 'talk to kaede')
    expect(floor).not.toBeNull()
    expect(provider.calls).toBe(1) // valid on the first attempt — no repair
    // The effect folded into canonical stat_data at generation (ADR 0008 §3 / ADR 0009 §4).
    const vars = capturedFloor!.variables as { stat_data: { hp: number } }
    expect(vars.stat_data.hp).toBe(42)
    // The floor stores the validated scene text as its response, and carries a valid-outcome trace.
    expect(capturedFloor!.response.content).toContain('<| effect')
    expect(capturedFloor!.yuzu_trace?.outcome).toBe('valid')
    expect(capturedFloor!.yuzu_trace?.attempts).toHaveLength(1)
  })

  it('VN mode: a structurally-invalid reply triggers ONE repair, then commits the repaired scene', async () => {
    yuzuFlag.on = true
    const invalid = 'Just some prose with no scene structure at all.' // no <| bg |> ⇒ missing location
    const repaired = '<| bg rooftop |>\nyuzu: There you are.\n<| effect _.add(\'hp\', 5) //relief |>\n<| end |>'
    provider.queue = [invalid, repaired]
    const floor = await generate('profile1', 'chat1', 'find yuzu')
    expect(floor).not.toBeNull()
    expect(provider.calls).toBe(2) // sample + exactly one repair re-ask
    // The REPAIRED scene is what commits (its effect folded: hp 10 → 15).
    expect(capturedFloor!.response.content).toBe(repaired)
    expect((capturedFloor!.variables as { stat_data: { hp: number } }).stat_data.hp).toBe(15)
    expect(capturedFloor!.yuzu_trace?.outcome).toBe('repaired')
    expect(capturedFloor!.yuzu_trace?.attempts).toHaveLength(2)
    expect(capturedFloor!.yuzu_trace?.originalRaw).toBe(invalid)
  })

  it('VN mode: repair still failing degrades to a prose-fallback floor (never throws)', async () => {
    yuzuFlag.on = true
    const invalid1 = 'First non-scene reply.'
    const invalid2 = 'Second non-scene reply, also broken.'
    provider.queue = [invalid1, invalid2]
    const floor = await generate('profile1', 'chat1', 'do something')
    expect(floor).not.toBeNull()
    expect(provider.calls).toBe(2) // sample + one repair, then the ladder floors out
    // Fallback wraps the ORIGINAL raw verbatim as the floor response; the trace records the fallback.
    expect(capturedFloor!.response.content).toBe(invalid1)
    expect(capturedFloor!.yuzu_trace?.outcome).toBe('fallback')
  })

  it('classic floors carry NO yuzu_trace (VN-only field)', async () => {
    // yuzuFlag stays off — a plain classic turn must never write the gate trace.
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    expect(capturedFloor!.yuzu_trace).toBeUndefined()
    expect(provider.calls).toBe(1) // classic: exactly one model call, no gate re-ask
  })
})
