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
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({}),
  saveGlobals: () => {}
}))
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

const { resolveWorkflowDoc, buildTurnContext, notifyWorkflowTrace } = vi.hoisted(() => ({
  resolveWorkflowDoc: vi.fn(),
  buildTurnContext: vi.fn(),
  notifyWorkflowTrace: vi.fn()
}))
vi.mock('../../src/main/services/workflowService', () => ({ resolveWorkflowDoc }))
vi.mock('../../src/main/services/workflowEvents', () => ({ notifyWorkflowTrace }))
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
    streamProviderMock.mockReset().mockImplementation(defaultStream)
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

  it('returns the floor from the doc-declared main-output node, not a hardcoded id', async () => {
    // A hand-authored graph names its nodes freely — rename every default id and re-point edges.
    const renamed = structuredClone(DEFAULT_GRAPH)
    const rename = (id: string): string => `${id}-x`
    renamed.nodes = renamed.nodes.map((n) => ({ ...n, id: rename(n.id) }))
    renamed.edges = renamed.edges.map((e) => ({
      from: { ...e.from, node: rename(e.from.node) },
      to: { ...e.to, node: rename(e.to.node) }
    }))
    resolveWorkflowDoc.mockReturnValue({ id: 'custom-2', doc: renamed })

    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    expect(appendFloorCalled).toBe(true)
  })

  it('delivers the floor at the phase boundary — a slow post-phase LLM never blocks the turn', async () => {
    vi.useRealTimers() // this test coordinates real promises, not timers
    // Default graph + a post-phase side LLM (not an ancestor of write → post phase).
    const doc = structuredClone(DEFAULT_GRAPH)
    doc.nodes.push({ id: 'llm2', type: 'llm.sample', config: { stream: false } })
    doc.edges.push(
      { from: { node: 'ctx', port: 'gen' }, to: { node: 'llm2', port: 'gen' } },
      { from: { node: 'assemble', port: 'sendMessages' }, to: { node: 'llm2', port: 'sendMessages' } },
      { from: { node: 'assemble', port: 'params' }, to: { node: 'llm2', port: 'params' } }
    )
    resolveWorkflowDoc.mockReturnValue({ id: 'custom-3', doc })

    // Call 1 = the main sample (fast). Call 2 = the side job — held open by the test.
    let releaseSideJob!: (v: string) => void
    const sideJob = new Promise<string>((r) => {
      releaseSideJob = r
    })
    streamProviderMock
      .mockImplementationOnce(defaultStream)
      .mockImplementationOnce(async () => sideJob)
    notifyWorkflowTrace.mockClear()

    // The player's floor arrives while the side job is still in flight…
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    expect(streamProviderMock).toHaveBeenCalledTimes(2) // side job started…
    expect(notifyWorkflowTrace).not.toHaveBeenCalled() // …but the run hasn't settled

    // …and the trace lands once the detached post phase completes.
    releaseSideJob('background job result')
    await vi.waitFor(() => expect(notifyWorkflowTrace).toHaveBeenCalledTimes(1))
    const trace = notifyWorkflowTrace.mock.calls[0][0]
    expect(trace.nodes.find((n: { nodeId: string }) => n.nodeId === 'llm2')?.status).toBe('ran')
  })

  it('broadcasts the run trace after the turn (spec §13 run/trace panel)', async () => {
    notifyWorkflowTrace.mockClear()
    await generate('profile1', 'chat1', 'open the door')

    expect(notifyWorkflowTrace).toHaveBeenCalledTimes(1)
    const trace = notifyWorkflowTrace.mock.calls[0][0]
    expect(trace).toMatchObject({ chatId: 'chat1', workflowId: 'custom-1', ok: true })
    // The default graph's nodes appear with real statuses; the LLM node ran.
    const llm = trace.nodes.find((n: { nodeType: string }) => n.nodeType === 'llm.sample')
    expect(llm?.status).toBe('ran')
    // Output previews never leak the Context bundle.
    const ctxNode = trace.nodes.find((n: { nodeType: string }) => n.nodeType === 'input.context')
    expect(ctxNode?.outputs).toBeUndefined()
  })
})
