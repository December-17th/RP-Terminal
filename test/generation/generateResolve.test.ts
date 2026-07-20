import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'
import { NARRATOR_SPINE_DOC as DEFAULT_GRAPH } from '../fixtures/narratorSpineDoc'

// Post-workflow entry shape (execution-plan M5c-1): `generate()` no longer resolves a workflow doc,
// builds a node RunContext, broadcasts a run trace, or persists run history — the detached post-turn
// chain is gone and the turn takes the direct orchestration. The doc-resolution / trace / run-history
// cases those behaviors pinned were removed here as a deliberate characterization update; the
// still-valid cases are the ST-faithful serialization + player-preempts-script behaviors `generate()`
// still owns. The workflow module mocks below are now inert (generate() imports none of them) and are
// retained only so the file's hoisted stubs load.

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

  it('runs the turn directly and persists the floor (no doc resolution)', async () => {
    const floor = await generate('profile1', 'chat1', 'open the door')

    expect(floor).not.toBeNull()
    expect(appendFloorCalled).toBe(true)
    expect(capturedFloor).not.toBeNull()
  })

  // M5c-1 note: the doc-resolution / run-trace / run-history cases were removed as a deliberate
  // characterization update. `generate()` no longer resolves a workflow doc, builds a node RunContext,
  // broadcasts a trace, or persists run history — the detached post-turn chain is deleted and memory
  // maintenance fires from the M3 trigger runtime instead. (M5a already removed two earlier cases.)

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

})
