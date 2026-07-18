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

// Project Yuzu WP-S1: a hoisted toggle so the SAME mocked module serves both the classic baseline
// (off → byte-identical) and the VN-mode case (on → overlay + raised ceiling). Off by default.
const yuzuFlag = vi.hoisted(() => ({ on: false }))

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
  getChatWorkflowId: () => null,
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
  getFloorRequest: () => undefined,
  getFloorCount: () => floors.length,
  saveFloor: () => {}
}))
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
    capturedSend = messages
    capturedParams = params
    return RAW
  }
}))

import { generate } from '../../src/main/services/generationService'

describe('generate() — parity baseline', () => {
  beforeEach(() => {
    capturedSend = null
    capturedParams = null
    capturedFloor = null
    yuzuFlag.on = false
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
})
