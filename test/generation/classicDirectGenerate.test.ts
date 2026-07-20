// Classic Narrator first execution plan — Milestone 3, at the REAL entry point.
//
// classicDirectParity.test.ts proves the two orchestrations agree. This file proves `generate()`
// actually runs the direct one for the production doc, that everything generate() owns around it still
// works there (response delivery, run trace, run history, failure surfacing), and — after M5a's hard
// cutover (D4) removed the `classicShape` predicate and the `runWorkflow` fallback — that an edited doc
// which USED to fall back now stays on the direct path and produces the same result.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'
import { buildDefaultMemoryDocV2 } from '../../src/main/services/nodes/builtin/defaultMemoryTemplate'

const settings = (() => {
  const s = getDefaultSettings()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'test-model' }
  s.agent = { mode: 'off' }
  return s
})()
const preset = getDefaultPreset()

const card = {
  id: 'card1',
  data: { name: 'Testchar', description: 'A calm guide.', personality: 'patient', extensions: {} }
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
  }
]

const appended: FloorFile[] = []
vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({ id: 'chat1', character_id: 'card1', floor_count: 1, lorebook_ids: null }),
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
  getFloor: () => floors[floors.length - 1],
  getFloorRequest: () => undefined,
  getFloorCount: () => floors.length,
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
vi.mock('../../src/main/services/executionRecordStore', () => ({ saveExecutionRecord: () => {} }))
vi.mock('../../src/main/services/agentRuntime/floorState', () => ({
  floorStateForChat: () => ({ setBaseline: () => {}, append: () => {}, replay: () => {} })
}))
vi.mock('../../src/main/services/tableTemplateService', () => ({
  getTableTemplateById: () => null
}))
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
const defaultStream = async (
  _s: unknown,
  _messages: unknown,
  _params: unknown,
  onDelta: (d: string) => void
): Promise<string> => {
  onDelta('You open the door.')
  return 'You open the door.'
}

const { resolveEffectiveDoc, notifyWorkflowTrace, appendRun } = vi.hoisted(() => ({
  resolveEffectiveDoc: vi.fn(),
  notifyWorkflowTrace: vi.fn(),
  appendRun: vi.fn(() => undefined)
}))
vi.mock('../../src/main/services/workflowService', () => ({
  resolveEffectiveDoc,
  setEnabledFragmentsProvider: () => {}
}))
vi.mock('../../src/main/services/workflowEvents', () => ({
  notifyWorkflowTrace,
  notifyWorkflowPanel: () => {},
  notifyWorkflowActivity: () => {}
}))
vi.mock('../../src/main/services/runHistoryStore', () => ({ appendRun }))

import { generate } from '../../src/main/services/generationService'

/** The seeded production doc, exactly as a profile stores it. */
const productionDoc = () => buildDefaultMemoryDocV2()

/** The same doc after a mid-session edit that the predicate must reject — a panel on a spine node. */
const editedDoc = () => {
  const doc = buildDefaultMemoryDocV2()
  doc.nodes.find((n) => n.id === 'assemble')!.panel = { show: true, label: 'Prompt' }
  return doc
}

/** The floor with its wall-clock stamps removed, for cross-turn comparison. */
const comparable = (f: FloorFile): unknown => {
  const { timestamp: _t, user_message, metrics, floor: _f, ...rest } = f as any
  const { timestamp: _ut, ...user } = user_message ?? {}
  const { ts: _mts, ...turn } = metrics?.turn ?? {}
  return { ...rest, user_message: user, metrics: { ...metrics, turn } }
}

beforeEach(() => {
  appended.length = 0
  resolveEffectiveDoc
    .mockReset()
    .mockReturnValue({ id: 'wf-seeded', doc: productionDoc(), warnings: [] })
  notifyWorkflowTrace.mockReset()
  appendRun.mockReset().mockReturnValue(undefined)
  streamProviderMock.mockReset().mockImplementation(defaultStream)
})

describe('generate() — the production doc routes to the direct orchestration', () => {
  it('returns the floor and persists it, with exactly one provider call', async () => {
    const floor = await generate('profile1', 'chat1', 'open the door')

    expect(floor).not.toBeNull()
    expect(appended).toHaveLength(1)
    expect(appended[0].response.content).toBe('You open the door.')
    expect(streamProviderMock).toHaveBeenCalledTimes(1)
  })

  it('still broadcasts a run trace covering every node of the doc', async () => {
    await generate('profile1', 'chat1', 'open the door')

    await vi.waitFor(() => expect(notifyWorkflowTrace).toHaveBeenCalledTimes(1))
    const trace = notifyWorkflowTrace.mock.calls[0][0]
    expect(trace).toMatchObject({ chatId: 'chat1', workflowId: 'wf-seeded', ok: true })
    expect(trace.nodes).toHaveLength(productionDoc().nodes.length)
    expect(trace.nodes.find((n: any) => n.nodeType === 'llm.sample')?.status).toBe('ran')
    // Output previews still never leak the Context bundle.
    expect(trace.nodes.find((n: any) => n.nodeType === 'input.context')?.outputs).toBeUndefined()
  })

  it('STILL RECORDS RUN HISTORY — the direct path is not a hole in the timeline', async () => {
    // A direct path emitting no traces would silently delete Classic run history. generate()'s
    // existing appendRun block is reached unchanged because the direct path returns a full RunResult.
    await generate('profile1', 'chat1', 'open the door')

    await vi.waitFor(() => expect(appendRun).toHaveBeenCalled())
    const [profileId, record] = appendRun.mock.calls[0] as [string, Record<string, unknown>]
    expect(profileId).toBe('profile1')
    expect(record.origin).toBe('turn')
    expect(record.packIds).toEqual([])
    expect((record.trace as any).chatId).toBe('chat1')
    expect((record.trace as any).nodes.length).toBe(productionDoc().nodes.length)
  })

  it('surfaces a hard provider failure as a thrown error, not a silent null', async () => {
    streamProviderMock.mockRejectedValue(new Error('provider exploded'))

    await expect(generate('profile1', 'chat1', 'open the door')).rejects.toThrow(
      /provider exploded/
    )
    expect(appended).toHaveLength(0)
  })

  it('streams deltas to the renderer callback', async () => {
    const deltas: string[] = []
    await generate('profile1', 'chat1', 'open the door', (d) => deltas.push(d))

    expect(deltas).toEqual(['You open the door.'])
  })
})

describe('generate() — an edited doc stays on the direct path (M5a hard cutover)', () => {
  it('a mid-session edit that USED to fall back now produces the same floor and prompt directly', async () => {
    // Turn 1 on the production doc…
    resolveEffectiveDoc.mockReturnValue({ id: 'wf-seeded', doc: productionDoc(), warnings: [] })
    const first = await generate('profile1', 'chat1', 'open the door')
    const firstPrompt = streamProviderMock.mock.calls[0][1]

    // …the user opens the editor and adds a panel to a spine node. Pre-M5a this demoted turn 2 onto
    // runWorkflow; post-cutover it stays direct. The result is unchanged because the direct path
    // ignores the panel (it emits none), so the same floor and prompt still come out.
    appended.length = 0
    streamProviderMock.mockClear()
    resolveEffectiveDoc.mockReturnValue({ id: 'wf-seeded', doc: editedDoc(), warnings: [] })
    const second = await generate('profile1', 'chat1', 'open the door')
    const secondPrompt = streamProviderMock.mock.calls[0][1]

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(secondPrompt).toEqual(firstPrompt)
    expect(comparable(second!)).toEqual(comparable(first!))
  })

  it('and flipping BACK is equally invisible', async () => {
    resolveEffectiveDoc.mockReturnValue({ id: 'wf-seeded', doc: editedDoc(), warnings: [] })
    const viaEdited = await generate('profile1', 'chat1', 'open the door')

    appended.length = 0
    streamProviderMock.mockClear()
    resolveEffectiveDoc.mockReturnValue({ id: 'wf-seeded', doc: productionDoc(), warnings: [] })
    const viaProduction = await generate('profile1', 'chat1', 'open the door')

    expect(comparable(viaProduction!)).toEqual(comparable(viaEdited!))
  })

  it('records run history for an edited doc too', async () => {
    resolveEffectiveDoc.mockReturnValue({ id: 'wf-seeded', doc: productionDoc(), warnings: [] })
    await generate('profile1', 'chat1', 'open the door')
    await vi.waitFor(() => expect(appendRun).toHaveBeenCalledTimes(1))

    resolveEffectiveDoc.mockReturnValue({ id: 'wf-seeded', doc: editedDoc(), warnings: [] })
    await generate('profile1', 'chat1', 'open the door')
    await vi.waitFor(() => expect(appendRun).toHaveBeenCalledTimes(2))

    const [, production] = appendRun.mock.calls[0] as [string, any]
    const [, edited] = appendRun.mock.calls[1] as [string, any]
    expect(production.origin).toBe(edited.origin)
    expect(production.trace.nodes.length).toBe(edited.trace.nodes.length)
    expect(production.trace.ok).toBe(edited.trace.ok)
  })
})
