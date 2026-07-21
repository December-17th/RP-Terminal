// Execution-plan M5a — Yuzu characterization (retires the old Session 9).
//
// After ADR 0008/0019 there is no separate Yuzu generation path: `vnMode` rides the SAME direct Classic
// orchestration (`runClassicTurnDirect`). This suite pins that parity at the two seams `generation/
// assemble.ts` applies it: the VN scene overlay (`:185` buildVnOverlay) and the Yuzu token budget
// (`:324` resolveYuzuMaxTokens). vnMode ON ⇒ the assembled prompt carries the overlay framing and the
// Yuzu max_tokens; vnMode OFF ⇒ neither (byte-classic). Leaves are mocked exactly as the classicTurn
// parity suite mocks them, with `isYuzuMode` the single toggle.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const yuzuState = vi.hoisted(() => ({ on: false }))

const floors = Array.from({ length: 3 }, (_, i) => ({
  floor: i,
  user_message: { content: `player action ${i}` },
  response: { content: `ai reply ${i}` },
  variables: {}
}))

const appendedFloors = vi.hoisted(() => [] as unknown[])
const mockChat = vi.hoisted(() => ({
  getChat: vi.fn(() => ({ character_id: 'w1', floor_count: 3 })),
  getChatTableTemplateId: vi.fn<() => string | null>(() => null),
  getChatLorebookIds: vi.fn(() => null),
  getChatMode: vi.fn(() => 'explore'),
  isYuzuMode: vi.fn(() => yuzuState.on),
  getChatWorkflowId: vi.fn(() => null),
  getCachedWorldInfo: vi.fn(() => null),
  setCachedWorldInfo: vi.fn(),
  appendFloor: vi.fn((_p: string, _c: string, f: unknown) => {
    appendedFloors.push(f)
  })
}))
vi.mock('../../src/main/services/chatService', () => mockChat)

const mockFloor = vi.hoisted(() => ({
  getFloor: vi.fn(() => floors[floors.length - 1]),
  getAllFloors: vi.fn(() => floors),
  getFloorCount: vi.fn(() => 3),
  getFloorRequest: vi.fn(() => undefined),
  saveFloor: vi.fn()
}))
vi.mock('../../src/main/services/floorService', () => mockFloor)

const mockTemplateService = vi.hoisted(() => ({ loadGlobals: vi.fn(() => ({})), saveGlobals: vi.fn() }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ...mockTemplateService
}))

vi.mock('../../src/main/services/executionRecordStore', () => ({ saveExecutionRecord: vi.fn() }))
vi.mock('../../src/main/services/agentRuntime/floorState', () => ({
  floorStateForChat: vi.fn(() => ({ setBaseline: vi.fn(), append: vi.fn(), replay: vi.fn() }))
}))
vi.mock('../../src/main/services/tableTemplateService', () => ({
  getTableTemplateById: vi.fn(() => null)
}))
vi.mock('../../src/main/services/tableProgressService', () => ({
  getProgress: vi.fn(() => ({})),
  advanceProgress: vi.fn(),
  computeTableProgress: vi.fn(),
  resolveUpdateFrequency: () => null
}))
vi.mock('../../src/main/services/tableStatusService', () => ({ getTablesStatus: vi.fn(() => ({})) }))
vi.mock('../../src/main/services/tableDbService', () => ({ readAllTables: vi.fn(() => []) }))
// buildVnOverlay reads world-asset indexes; fail-soft to empty vocabulary keeps the overlay framing.
vi.mock('../../src/main/services/worldAssetService', () => ({
  getIndex: vi.fn(() => {
    throw new Error('no index')
  })
}))

const mockCallModel = vi.hoisted(() => ({
  callModel: vi.fn(async () => ({ raw: 'The door opens.', rawUsage: {}, stopped: false }))
}))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)
vi.mock('../../src/main/services/logService', () => ({ log: vi.fn() }))

import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
vi.mock('../../src/main/services/settingsService', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const s = (real.getDefaultSettings as typeof getDefaultSettings)()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'm' }
  s.agent = { mode: 'off' }
  return { ...real, getSettings: () => s }
})
vi.mock('../../src/main/services/characterService', () => ({
  getCharacter: () => ({ id: 'w1', data: { name: 'C', description: 'calm', extensions: {} } })
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLorebookById: () => ({ id: 'w1', name: 'lb', entries: [] })
}))
vi.mock('../../src/main/services/regexService', () => ({
  getPromptRules: () => [],
  getWorldInfoRules: () => []
}))
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => getDefaultPreset(),
  getActivePresetId: () => 'p'
}))

import { runClassicTurnDirect } from '../../src/main/services/generation/classicTurn'
import { RunContext } from '../../src/main/services/generation/runContext'
import { VN_MODE_FRAMING } from '../../src/main/services/yuzu/vnPrompt'
import { YUZU_DEFAULT_MAX_TOKENS } from '../../src/main/services/settingsService'

const turnCtx = (): RunContext => {
  const graph = new AbortController()
  return {
    profileId: 'prof',
    chatId: 'c1',
    workflowId: 'default',
    userAction: 'open the door',
    signal: graph.signal,
    abortGraph: () => graph.abort(),
    streamMain: () => {},
    emitPanel: () => {},
    getNodeState: () => undefined,
    setNodeState: () => {}
  }
}

/** Every message's text concatenated — the overlay lands in a system block near the user action. */
const promptText = (): string => {
  const messages = mockCallModel.callModel.mock.calls[0]?.[1] as Array<{ content: string }>
  return messages.map((m) => m.content).join('\n')
}
const params = (): { max_tokens?: number } =>
  mockCallModel.callModel.mock.calls[0]?.[2] as { max_tokens?: number }

beforeEach(() => {
  appendedFloors.length = 0
  vi.clearAllMocks()
  mockCallModel.callModel.mockResolvedValue({ raw: 'The door opens.', rawUsage: {}, stopped: false })
})

describe('Yuzu vnMode rides the direct Classic path', () => {
  it('vnMode ON carries the VN overlay and the Yuzu token budget', async () => {
    yuzuState.on = true
    await runClassicTurnDirect(turnCtx())

    expect(promptText()).toContain(VN_MODE_FRAMING)
    expect(params().max_tokens).toBe(YUZU_DEFAULT_MAX_TOKENS)
  })

  it('vnMode OFF carries NEITHER — byte-classic assembly', async () => {
    yuzuState.on = false
    await runClassicTurnDirect(turnCtx())

    expect(promptText()).not.toContain(VN_MODE_FRAMING)
    expect(params().max_tokens).toBe(getDefaultPreset().parameters.max_tokens)
    // Not vacuously equal to the Yuzu budget.
    expect(params().max_tokens).not.toBe(YUZU_DEFAULT_MAX_TOKENS)
  })
})
