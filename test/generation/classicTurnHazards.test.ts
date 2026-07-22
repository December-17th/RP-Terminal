// Final-review Finding 4: the deleted classicTurnInventory pins covered the off-port `gen` side channels
// that classicTurn.ts:26-38 documents as "PARITY HAZARD" — a port-only rewrite (or a stray clone) would
// silently drop them while the turn still SUCCEEDS. This focused suite re-pins the three that matter, at
// the real direct-path entry (`runClassicTurnDirect`), with the same leaf mocks classicDirectGenerate
// uses. It spies (real passthrough) on `assemblePrompt` only to capture the ONE shared `gen` object, so
// the identity assertions genuinely fail if classicTurn ever clones/spreads it.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'
import type { GenContext } from '../../src/main/services/generation/types'
import type { RunContext } from '../../src/main/services/generation/runContext'

const settings = (() => {
  const s = getDefaultSettings()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'test-model' }
  s.agent = { mode: 'off' }
  return s
})()

const card = {
  id: 'card1',
  data: { name: 'Testchar', description: 'A calm guide.', personality: 'patient', extensions: {} }
} as any

// Mutable so a test can drive the floor-0 (opening-turn) branch: getChat.floor_count IS the next floor
// index, and foldState stamps the FloorState baseline only when it is 0.
const chatState = vi.hoisted(() => ({ floorCount: 1 }))
const priorFloors: FloorFile[] = [
  {
    floor: 0,
    chat_id: 'chat1',
    timestamp: '2020-01-01T00:00:00.000Z',
    user_message: { content: '', timestamp: '2020-01-01T00:00:00.000Z' },
    response: { content: 'Hello.', model: 'test-model', provider: 'openai' },
    events: [],
    variables: { stat_data: { hp: 10 } }
  }
]

const appended: FloorFile[] = []
vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({ id: 'chat1', character_id: 'card1', floor_count: chatState.floorCount, lorebook_ids: null }),
  getChatLorebookIds: () => null,
  getChatTableTemplateId: () => null,
  getChatMode: () => 'explore',
  isYuzuMode: () => false,
  getChatWorkflowId: () => null,
  getCachedWorldInfo: () => null,
  setCachedWorldInfo: () => {},
  appendFloor: (_p: string, _c: string, f: FloorFile) => {
    appended.push(f)
  },
  truncateFloors: () => {}
}))
vi.mock('../../src/main/services/characterService', () => ({ getCharacter: () => card }))
vi.mock('../../src/main/services/settingsService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSettings: () => settings
}))

// A test can plant a real `{{setvar}}` macro — or an EJS `<% setvar() %>` tag — in the preset's main
// block, so a BUILD-TIME variable mutation genuinely fires during assembly against the shared
// gen.workingVars (by reference). Both dialects write the SAME store by different routes.
const presetState = vi.hoisted(() => ({ macro: '' }))
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => {
    const preset = getDefaultPreset()
    if (presetState.macro) {
      const main = preset.prompts.find((p) => p.identifier === 'main')!
      main.content = `${main.content}\n${presetState.macro}`
    }
    return preset
  },
  getActivePresetId: () => 'preset1'
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLorebookById: () => ({ id: 'card1', name: 'lb', entries: [] })
}))
vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: () => priorFloors.slice(0, chatState.floorCount),
  getFloor: () => priorFloors[chatState.floorCount - 1],
  getFloorRequest: () => undefined,
  getFloorCount: () => chatState.floorCount,
  saveFloor: () => {}
}))
vi.mock('../../src/main/services/regexService', () => ({
  getPromptRules: () => [],
  getWorldInfoRules: () => []
}))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({}),
  saveGlobals: () => {}
}))

// The three off-port consumers: their call sites are the evidence.
const mockRecordStore = vi.hoisted(() => ({ saveExecutionRecord: vi.fn() }))
vi.mock('../../src/main/services/executionRecordStore', () => mockRecordStore)
const mockFloorState = vi.hoisted(() => {
  const setBaseline = vi.fn()
  const journal = vi.fn()
  return {
    setBaseline,
    journal,
    floorStateForChat: vi.fn(() => ({ setBaseline, journal, append: vi.fn(), replay: vi.fn() }))
  }
})
vi.mock('../../src/main/services/agentRuntime/floorState', () => ({
  floorStateForChat: mockFloorState.floorStateForChat
}))

vi.mock('../../src/main/services/tableTemplateService', () => ({ getTableTemplateById: () => null }))
vi.mock('../../src/main/services/tableProgressService', () => ({
  getProgress: () => ({}),
  advanceProgress: () => {},
  computeTableProgress: () => {},
  resolveUpdateFrequency: () => null
}))
vi.mock('../../src/main/services/tableDbService', () => ({ readAllTables: () => [] }))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))

const { streamProviderMock } = vi.hoisted(() => ({ streamProviderMock: vi.fn() }))
vi.mock('../../src/main/services/apiService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  streamProvider: streamProviderMock
}))

// Spy on assemblePrompt with REAL passthrough — the only stage touched — purely to capture the shared
// `gen`. matchWorldInfo (also from ./assemble) passes through untouched.
const assembleSpy = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../src/main/services/generation/assemble', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const assemblePrompt = real.assemblePrompt as (...a: unknown[]) => unknown
  return {
    ...real,
    assemblePrompt: (...args: unknown[]) => {
      assembleSpy.fn(...args)
      return assemblePrompt(...args)
    }
  }
})

import { runClassicTurnDirect } from '../../src/main/services/generation/classicTurn'
import { initTemplates } from '../../src/main/services/templateService'

const capturedGen = (): GenContext => assembleSpy.fn.mock.calls[0][0] as GenContext

const turnCtx = (): RunContext => ({
  profileId: 'profile1',
  chatId: 'chat1',
  userAction: 'open the door',
  generationType: 'normal',
  signal: new AbortController().signal,
  modelSignal: new AbortController().signal,
  abortGraph: () => {},
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

// The EJS dialect needs a live sandbox — without it evalTemplate STRIPS `<% … %>` instead of running it.
beforeAll(async () => {
  await initTemplates()
})

beforeEach(() => {
  appended.length = 0
  chatState.floorCount = 1
  presetState.macro = ''
  priorFloors[0].variables = { stat_data: { hp: 10 } }
  vi.clearAllMocks()
  streamProviderMock.mockImplementation(
    async (_s: unknown, _m: unknown, _p: unknown, onDelta: (d: string) => void): Promise<string> => {
      onDelta('You open the door.')
      return 'You open the door.'
    }
  )
})

describe('classicTurn off-port gen side channels (Finding 4)', () => {
  it('(a) a build-time {{setvar}} mutation of gen.workingVars by reference reaches the persisted floor', async () => {
    presetState.macro = '{{setvar::probeVar::planted-at-build}}'

    const floor = await runClassicTurnDirect(turnCtx())

    expect(floor).not.toBeNull()
    // Were gen (or workingVars) cloned between assemble and persist, the build-time value would be lost
    // silently — the turn would still succeed, the floor would just quietly miss it.
    expect(appended[0].variables.probeVar).toBe('planted-at-build')
    // Identity: the persisted variables ARE the shared gen.workingVars foldState mutated in place.
    expect(appended[0].variables).toBe(capturedGen().workingVars)
  })

  // Reaching the floor is not enough: nothing can re-derive a build-time write from the response, so
  // unless the turn JOURNALS it, Forward Replay rebuilds the floor without it.
  it('(a2) the same build-time {{setvar}} mutation is journaled as a pre-fold template operation', async () => {
    presetState.macro = '{{setvar::probeVar::planted-at-build}}'

    await runClassicTurnDirect(turnCtx())

    expect(mockFloorState.journal).toHaveBeenCalledTimes(1)
    const [chatId, floorNumber, source, operations] = mockFloorState.journal.mock.calls[0]
    expect({ chatId, floorNumber, source }).toEqual({
      chatId: 'chat1',
      floorNumber: 1,
      source: 'template'
    })
    expect(operations).toEqual([
      { kind: 'set', path: 'variables.probeVar', value: 'planted-at-build' }
    ])
  })

  // The write a DIFF cannot see: assembly forces `probeVar` to the value it ALREADY inherited. Nothing
  // changed, so nothing is journaled unless the WRITE ITSELF was recorded — and a later edit of an
  // earlier floor would then replay this floor without the value assembly demanded.
  it('(a2) a build-time setvar of an ALREADY-EQUAL value is journaled all the same', async () => {
    priorFloors[0].variables = { stat_data: { hp: 10 }, probeVar: 'planted-at-build' }
    presetState.macro = "<% setvar('probeVar', 'planted-at-build') %>"

    await runClassicTurnDirect(turnCtx())

    expect(appended[0].variables.probeVar).toBe('planted-at-build')
    expect(mockFloorState.journal).toHaveBeenCalledTimes(1)
    expect(mockFloorState.journal.mock.calls[0][3]).toEqual([
      { kind: 'set', path: 'variables.probeVar', value: 'planted-at-build' }
    ])
  })

  it('(a2) a build-time setvar into GLOBAL scope is not journaled onto the floor', async () => {
    presetState.macro = "<% setGlobalVar('probeVar', 'globals-only') %>"

    await runClassicTurnDirect(turnCtx())

    expect(appended[0].variables.probeVar).toBeUndefined()
    expect(mockFloorState.journal).not.toHaveBeenCalled()
  })

  it('(a2) a turn with no build-time variable write journals nothing', async () => {
    await runClassicTurnDirect(turnCtx())

    expect(mockFloorState.journal).not.toHaveBeenCalled()
  })

  it('(b) gen.executionRecord stamped at assembly is the exact object persistFloor stores', async () => {
    const floor = await runClassicTurnDirect(turnCtx())

    expect(floor).not.toBeNull()
    expect(capturedGen().executionRecord).toBeDefined()
    expect(mockRecordStore.saveExecutionRecord).toHaveBeenCalledTimes(1)
    // Identity, not equality: the exact object assemble stamped onto gen is the one that reached the store.
    expect(mockRecordStore.saveExecutionRecord.mock.calls[0][2]).toBe(capturedGen().executionRecord)
  })

  it('(c) floor 0 stamps gen.floorStateBaseline and write consumes THAT object; later floors do not', async () => {
    chatState.floorCount = 0 // the opening turn
    const floor = await runClassicTurnDirect(turnCtx())

    expect(floor).not.toBeNull()
    expect(capturedGen().floorStateBaseline).toBeDefined()
    expect(mockFloorState.setBaseline).toHaveBeenCalledTimes(1)
    expect(mockFloorState.setBaseline.mock.calls[0][1]).toBe(capturedGen().floorStateBaseline)
  })

  it('(c) a later floor (floor_count > 0) sets NO baseline', async () => {
    chatState.floorCount = 1
    const floor = await runClassicTurnDirect(turnCtx())

    expect(floor).not.toBeNull()
    expect(mockFloorState.setBaseline).not.toHaveBeenCalled()
  })
})
