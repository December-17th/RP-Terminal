import { beforeEach, describe, expect, it, vi } from 'vitest'

const yuzuState = vi.hoisted(() => ({ on: false, bound: true }))
const directorRun = vi.hoisted(() => vi.fn())
const floors = Array.from({ length: 3 }, (_, i) => ({
  floor: i,
  user_message: { content: `player action ${i}` },
  response: { content: `ai reply ${i}` },
  variables: {}
}))
const appendedFloors = vi.hoisted(() => [] as any[])

const mockChat = vi.hoisted(() => ({
  getChat: vi.fn(() => ({ character_id: 'w1', floor_count: 3 })),
  getChatTableTemplateId: vi.fn<() => string | null>(() => null),
  getChatLorebookIds: vi.fn(() => null),
  getChatMode: vi.fn(() => 'explore'),
  isYuzuMode: vi.fn(() => yuzuState.on),
  getChatWorkflowId: vi.fn(() => null),
  getCachedWorldInfo: vi.fn(() => null),
  setCachedWorldInfo: vi.fn(),
  appendFloor: vi.fn((_p: string, _c: string, floor: any) => appendedFloors.push(floor))
}))
vi.mock('../../src/main/services/chatService', () => mockChat)

const mockFloor = vi.hoisted(() => ({
  getFloor: vi.fn(() => floors.at(-1)),
  getAllFloors: vi.fn(() => floors),
  getFloorCount: vi.fn(() => 3),
  getFloorRequest: vi.fn(() => undefined),
  saveFloor: vi.fn(),
  onTranscriptCut: vi.fn(),
  onTranscriptEdited: vi.fn(),
  updateActiveFloorResponse: vi.fn(
    (_profileId: string, _chatId: string, floorIndex: number, content: string) => {
      const floor = appendedFloors.find((candidate) => candidate.floor === floorIndex)
      if (!floor) return null
      floor.response.content = content
      floor.swipes = [content]
      floor.swipe_id = 0
      return floor
    }
  )
}))
vi.mock('../../src/main/services/floorService', () => mockFloor)

vi.mock('../../src/main/services/agentRuntime/catalog', () => ({
  AgentCatalog: class {
    getRoleBindings() {
      return yuzuState.bound ? { 'yuzu.sceneDirector': 'Director' } : {}
    }
    get() {
      return {
        name: 'Director',
        enabled: true,
        invocationConfig: { apiPresetId: 'director-preset' }
      }
    }
  }
}))
vi.mock('../../src/main/services/agentRuntime/InvocationRuntimeService', () => ({
  invocationRuntime: () => ({ run: directorRun })
}))

vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: vi.fn(() => ({})),
  saveGlobals: vi.fn()
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
vi.mock('../../src/main/services/tableStatusService', () => ({
  getTablesStatus: vi.fn(() => ({}))
}))
vi.mock('../../src/main/services/tableDbService', () => ({ readAllTables: vi.fn(() => []) }))
vi.mock('../../src/main/services/worldAssetService', () => ({
  getIndex: vi.fn(() => ({
    character: { 柚子: { 立绘: { moods: { 微笑: 'smile.png' } } } },
    location: { 教室: { 背景: { moods: {} } } }
  }))
}))

const mockCallModel = vi.hoisted(() => ({ callModel: vi.fn() }))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)
vi.mock('../../src/main/services/logService', () => ({ log: vi.fn() }))

import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
vi.mock('../../src/main/services/settingsService', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const settings = (real.getDefaultSettings as typeof getDefaultSettings)()
  settings.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'm' }
  settings.agent = { mode: 'off' }
  return { ...real, getSettings: () => settings }
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
import type { RunContext } from '../../src/main/services/generation/runContext'

const RAW = "The door opens.\n<UpdateVariable>_.set('hp', 0, 5);</UpdateVariable>"
const ANNOTATED = `<| block |>\n<| bg 教室 |>\n${RAW}\n<| end |>`

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

const narratorPromptText = (): string => {
  const messages = mockCallModel.callModel.mock.calls[0]?.[1] as Array<{ content: string }>
  return messages.map((message) => message.content).join('\n')
}

beforeEach(() => {
  appendedFloors.length = 0
  vi.clearAllMocks()
  yuzuState.on = false
  yuzuState.bound = true
  mockCallModel.callModel.mockResolvedValue({ raw: RAW, rawUsage: {}, stopped: false })
  directorRun.mockResolvedValue({ status: 'succeeded', result: ANNOTATED })
})

describe('Yuzu Classic-narrator then scene-director path', () => {
  it('uses the unchanged Classic prompt/budget, folds narrator MVU once, then stores valid annotation', async () => {
    yuzuState.on = true
    const floor = await runClassicTurnDirect(turnCtx())

    expect(narratorPromptText()).not.toContain('Yuzu Scene Script')
    expect(mockCallModel.callModel.mock.calls[0]?.[2]).toMatchObject({
      max_tokens: getDefaultPreset().parameters.max_tokens
    })
    expect(appendedFloors).toHaveLength(1)
    expect(appendedFloors[0].variables.stat_data.hp).toBe(5)
    expect(directorRun).toHaveBeenCalledTimes(1)
    expect(mockChat.appendFloor.mock.invocationCallOrder[0]).toBeLessThan(
      directorRun.mock.invocationCallOrder[0]
    )
    expect(directorRun.mock.calls[0]?.[0]).toMatchObject({
      agent: 'Director',
      floor: 3,
      options: {
        apiPresetId: 'director-preset',
        maxRetryAttempts: 0,
        maxSteps: 1,
        required: false
      },
      acceptRawTextResult: true,
      restartOnSourceChange: false,
      skipResultIncorporation: true
    })
    const directorPrompt = directorRun.mock.calls[0]?.[0].promptOverride[0].content[0].text
    expect(directorPrompt).toContain(RAW)
    expect(directorPrompt).toContain('- 教室')
    expect(directorPrompt).toContain('- 柚子\n  - 微笑')
    expect(mockFloor.updateActiveFloorResponse).toHaveBeenCalledWith('prof', 'c1', 3, ANNOTATED)
    expect(floor?.response.content).toBe(ANNOTATED)
    expect(floor?.swipes?.[floor.swipe_id ?? 0]).toBe(ANNOTATED)
  })

  it.each([
    ['no role binding', () => (yuzuState.bound = false)],
    ['Agent failure', () => directorRun.mockResolvedValue({ status: 'failed' })],
    [
      'structurally invalid annotation',
      () => directorRun.mockResolvedValue({ status: 'succeeded', result: '<| music x |>\nChanged' })
    ]
  ])('%s preserves the raw narrator floor', async (_label, arrange) => {
    yuzuState.on = true
    arrange()
    const floor = await runClassicTurnDirect(turnCtx())
    expect(floor?.response.content).toBe(RAW)
    expect(mockFloor.updateActiveFloorResponse).not.toHaveBeenCalled()
  })

  it('Classic mode never invokes the scene director', async () => {
    const floor = await runClassicTurnDirect(turnCtx())
    expect(directorRun).not.toHaveBeenCalled()
    expect(floor?.response.content).toBe(RAW)
  })
})
