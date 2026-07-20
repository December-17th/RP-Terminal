import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'
import { NARRATOR_SPINE_DOC as DEFAULT_GRAPH } from '../fixtures/narratorSpineDoc'

// Proves generate() actually consumes workflowService.resolveEffectiveDoc (rather than a
// hardcoded 'default' literal + a fixed doc) and threads the resolved id through to
// buildTurnContext — the wiring Task 5 adds on top of Task 3 (resolver) + Task 4 (ctx arg).
// (agent-packs plan WP1.3: the single doc-resolution call site moved from resolveWorkflowDoc to
// resolveEffectiveDoc — the narrator composed with enabled packs. With no packs the effective doc
// IS the narrator, so this test's behavior is unchanged; only the mocked collaborator name +
// its return shape { id, doc, warnings } changed.)

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
  isYuzuMode: () => false,
  // M5a single-path direct: the table-export stage always runs and reads this (null ⇒ empty).
  getChatTableTemplateId: () => null,
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

const { resolveEffectiveDoc, buildTurnContext, notifyWorkflowTrace } = vi.hoisted(() => ({
  resolveEffectiveDoc: vi.fn(),
  buildTurnContext: vi.fn(),
  notifyWorkflowTrace: vi.fn()
}))
// setEnabledFragmentsProvider is added to the mock only for module-load completeness: generate() now
// transitively imports headlessRunService → agentPackService (the WP2.2 turn-boundary hook), and
// agentPackService calls setEnabledFragmentsProvider at import time. generate() itself never calls it;
// this stub just keeps the partial workflowService mock loadable. No assertion depends on it.
vi.mock('../../src/main/services/workflowService', () => ({
  resolveEffectiveDoc,
  setEnabledFragmentsProvider: () => {}
}))
vi.mock('../../src/main/services/workflowEvents', () => ({ notifyWorkflowTrace }))
// Run-history persistence (WP2.3): the turn path persists on the SAME detached promise as the trace
// broadcast. Mock the store (its sqlite table can't load under Node) and assert the annotated record.
const { appendRun } = vi.hoisted(() => ({ appendRun: vi.fn(() => undefined) }))
vi.mock('../../src/main/services/runHistoryStore', () => ({ appendRun }))
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
    resolveEffectiveDoc
      .mockReset()
      .mockReturnValue({ id: 'custom-1', doc: DEFAULT_GRAPH, warnings: [] })
    buildTurnContext.mockClear()
    appendRun.mockReset().mockReturnValue(undefined)
    streamProviderMock.mockReset().mockImplementation(defaultStream)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-06-01T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('calls resolveEffectiveDoc(profileId, chatId) and threads its id into buildTurnContext', async () => {
    const floor = await generate('profile1', 'chat1', 'open the door')

    expect(resolveEffectiveDoc).toHaveBeenCalledWith('profile1', 'chat1')
    expect(buildTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'custom-1' })
    )
    expect(floor).not.toBeNull()
    expect(appendFloorCalled).toBe(true)
    expect(capturedFloor).not.toBeNull()
  })

  // M5a note: two cases were removed here as a deliberate characterization update. `generate()` is now
  // single-path direct (D4 hard cutover) and no longer runs the workflow engine, so the two behaviors
  // those cases pinned — resolving a floor by an ARBITRARILY-renamed doc's main-output id, and running a
  // POST-PHASE side LLM detached from the turn — are workflow-engine features `generate()` no longer
  // exercises (the direct path addresses the fixed seeded spine and has no post phase). The engine and
  // those behaviors are deleted wholesale in M5b.

  it('rejects a SECOND concurrent generate for the same chat (ST-faithful serialization)', async () => {
    vi.useRealTimers() // real promise coordination
    // Hold the first turn's provider call open so it is genuinely in flight.
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => {
      release = r
    })
    streamProviderMock.mockImplementation(async (_s, _m, _p, onDelta: (d: string) => void) => {
      const text = await gate
      onDelta(text)
      return text
    })
    const first = generate('profile1', 'chat1', 'open the door')
    await new Promise((r) => setTimeout(r, 10)) // let the first run reach the provider

    // A SCRIPT caller (a card's TH.generate) mid-PLAYER-turn is refused, like SillyTavern refuses it.
    await expect(
      generate('profile1', 'chat1', 'script-triggered call', () => {}, 'script')
    ).rejects.toThrow(/already in progress/i)

    release('You open the door.')
    expect(await first).not.toBeNull()

    // The chat is usable again once the turn delivered.
    streamProviderMock.mockImplementation(defaultStream)
    expect(await generate('profile1', 'chat1', 'again')).not.toBeNull()
  })

  it('a PLAYER call PREEMPTS an in-flight SCRIPT turn — aborts it and proceeds', async () => {
    vi.useRealTimers()
    // The script turn's provider call hangs until aborted (resolving with its partial text —
    // the abort-with-text path); the player's subsequent calls use the normal fast stream.
    let scriptAborted = false
    streamProviderMock
      .mockImplementationOnce(
        (_s: unknown, _m: unknown, _p: unknown, _d: unknown, signal: AbortSignal) =>
          new Promise<string>((resolve) => {
            signal.addEventListener('abort', () => {
              scriptAborted = true
              resolve('interrupted script text')
            })
          })
      )
      .mockImplementation(defaultStream)

    const scriptTurn = generate('profile1', 'chat1', 'script call', () => {}, 'script')
    await new Promise((r) => setTimeout(r, 10)) // let the script turn reach the provider

    // The player's send does NOT get refused — it aborts the script turn and runs.
    const playerFloor = await generate('profile1', 'chat1', 'open the door')
    expect(scriptAborted).toBe(true)
    expect(playerFloor).not.toBeNull()
    await scriptTurn // the preempted turn settles without throwing
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

  it('persists a run-history record with origin "turn" (WP2.3), packIds [] for a plain narrator', async () => {
    vi.useRealTimers() // detached persist promise resolves on a microtask, not a timer
    appendRun.mockClear()
    await generate('profile1', 'chat1', 'open the door')

    // Persist rides the same DETACHED promise as the trace broadcast — wait for it to settle.
    await vi.waitFor(() => expect(appendRun).toHaveBeenCalled())
    const [profileId, record] = appendRun.mock.calls[0] as [string, Record<string, unknown>]
    expect(profileId).toBe('profile1')
    expect(record.origin).toBe('turn')
    // DEFAULT_GRAPH carries no composition meta → no pack nodes → []; no trigger on a turn.
    expect(record.packIds).toEqual([])
    expect(record.trigger).toBeUndefined()
    expect((record.trace as { chatId: string }).chatId).toBe('chat1')
  })

  it('a run-history persist failure never breaks the turn (WP2.3 fail-safe)', async () => {
    vi.useRealTimers()
    appendRun.mockImplementation(() => {
      throw new Error('db down')
    })
    // The floor still returns normally despite the persist throw (caught + logged on the detached path).
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    expect(appendFloorCalled).toBe(true)
  })
})
