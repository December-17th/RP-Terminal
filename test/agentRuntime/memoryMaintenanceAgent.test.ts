import { describe, it, expect, vi, beforeEach } from 'vitest'

// M4 — the converted `memory.maintain` built-in "Memory Maintenance" Agent (execution-plan §4;
// parser-backed design §6). Two surfaces are exercised:
//   · the main-side bridge (memoryMaintenanceAgentBridge) — due-gate, prompt compose, and the verbatim
//     three-way <TableEdit> discrimination + staleness fence;
//   · createTriggerDispatch — the dispatch decision (skip when nothing due; apply after success; no
//     apply on abort/failure).
// Only leaf state services are mocked; `extractTagAll` is the REAL pure parser so the [] vs [''] split
// is genuinely tested, and `composeMaintainerMessages` is spied so "the agent path routes through the
// SAME shared composer the preview IPC uses" is a structural fact, not a re-implementation.

// M5c-1 scaffold re-home: the bridge no longer reads the workflow doc via resolveEffectiveDoc — it
// composes from the BUILT-IN default (`DEFAULT_MEMORY_MAINTAIN_CONFIG`, real here) overlaid with the
// Agent's profile-local `invocation_config.maintain` override, read off the catalog. Drive the override
// through a stubbed AgentCatalog; `db` is stubbed so no real sqlite loads.
const overrideState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../src/main/services/agentRuntime/catalog', () => ({
  AgentCatalog: class {
    get() {
      return { invocationConfig: { maintain: overrideState.value } }
    }
  }
}))
vi.mock('../../src/main/services/db', () => ({ getDb: vi.fn(() => ({})) }))

const mockGen = vi.hoisted(() => ({
  buildGenContext: vi.fn((profileId: string, chatId: string) => ({ profileId, chatId }))
}))
vi.mock('../../src/main/services/generation/genContext', () => mockGen)

const template = {
  tables: [
    { sqlName: 'summary', displayName: 'Summary' },
    { sqlName: 'log', displayName: 'Log' }
  ]
}
const mockCore = vi.hoisted(() => ({
  chatTemplate: vi.fn<() => unknown>(() => null),
  dueTables: vi.fn<() => string[]>(() => []),
  applyTableEdit: vi.fn(() => ({ applied: 1, changes: 1 }))
}))
vi.mock('../../src/main/services/memory/memoryCore', () => mockCore)

// Real memoryMaintainConfig (a zod schema used with safeParse); composeMaintainerMessages spied. Both
// now live in `services/memory/maintainerCompose` (execution-plan M5b relocation), so that is the mock
// target the bridge resolves through.
const composeSpy = vi.hoisted(() =>
  vi.fn(() => [
    { role: 'system' as const, content: 'SCOPE' },
    { role: 'user' as const, content: 'BODY' }
  ])
)
vi.mock('../../src/main/services/memory/maintainerCompose', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return { ...real, composeMaintainerMessages: composeSpy }
})

const mockProgress = vi.hoisted(() => ({ getProgress: vi.fn(() => ({})), advanceProgress: vi.fn() }))
vi.mock('../../src/main/services/tableProgressService', () => mockProgress)

const epochState = vi.hoisted(() => ({ value: 5 }))
const mockFloorSvc = vi.hoisted(() => ({
  getFloorCount: vi.fn(() => 4),
  transcriptEpoch: vi.fn(() => epochState.value)
}))
vi.mock('../../src/main/services/floorService', () => mockFloorSvc)

const mockSettings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ tables: { default_update_frequency: 3 } }))
}))
vi.mock('../../src/main/services/settingsService', () => mockSettings)

vi.mock('../../src/main/services/tableMaintenance', () => ({
  writeScopeDirective: vi.fn((names: string[]) => `scope:${names.join(',')}`)
}))
vi.mock('../../src/main/services/logService', () => ({ log: vi.fn() }))

// Importing the bridge registers it into the slot (side effect), exactly as main/index.ts does.
import '../../src/main/services/memoryMaintenanceAgentBridge'
import { memoryMaintenanceBridge } from '../../src/main/services/agentRuntime/memoryMaintenanceSlot'
import {
  createTriggerDispatch,
  type TriggerDispatchRequest
} from '../../src/main/services/agentRuntime/triggerRuntime'
import { withMemoryMaintenanceApply } from '../../src/main/services/agentRuntime/memoryMaintenanceApply'
import type {
  InvocationOutcome,
  InvocationPromise,
  InvocationRequest,
  InvocationRuntime
} from '../../src/main/services/agentRuntime/invocation'

const bridge = () => {
  const b = memoryMaintenanceBridge()
  if (!b) throw new Error('bridge not registered')
  return b
}

// The bridge's effective maintainer config is DEFAULT ⊕ invocation_config.maintain. Set a `messages`
// override so the composer receives the same distinctive scaffold this suite asserts on (proving the
// override overlays the built-in default), exactly where the doc's maintain-node config used to feed it.
const withMaintainDoc = (): void => {
  overrideState.value = { messages: [{ role: 'system', content: 'x' }] }
}

const scope = { profileId: 'p', chatId: 'c1', floor: 7 }

beforeEach(() => {
  vi.clearAllMocks()
  epochState.value = 5
  overrideState.value = {}
  mockCore.chatTemplate.mockReturnValue(null)
  mockCore.dueTables.mockReturnValue([])
  mockGen.buildGenContext.mockImplementation((p: string, c: string) => ({ profileId: p, chatId: c }))
  mockFloorSvc.getFloorCount.mockReturnValue(4)
  mockFloorSvc.transcriptEpoch.mockImplementation(() => epochState.value)
  mockSettings.getSettings.mockReturnValue({ tables: { default_update_frequency: 3 } } as never)
  composeSpy.mockReturnValue([
    { role: 'system', content: 'SCOPE' },
    { role: 'user', content: 'BODY' }
  ])
})

describe('Memory Maintenance bridge — planDispatch due-gate', () => {
  // M5c-1: the maintainer config is now ALWAYS present (the built-in default ⊕ any override), so the
  // bridge no longer skips for a missing doc/maintain-node — the null skips are template + due only. The
  // off-switch is the Agent's `enabled` flag (the trigger runtime skips a disabled Agent before the
  // bridge is consulted), so the bridge reads no doc `control.mode` off state either.

  it('skips (null) when no table template is bound', () => {
    withMaintainDoc()
    mockCore.chatTemplate.mockReturnValue(null)
    expect(bridge().planDispatch(scope)).toBeNull()
  })

  it('skips (null) when no tables are due — no provider call, no Run Record', () => {
    withMaintainDoc()
    mockCore.chatTemplate.mockReturnValue(template)
    mockCore.dueTables.mockReturnValue([])
    expect(bridge().planDispatch(scope)).toBeNull()
  })

  it('returns an EMPTY plan (work to do, no preset) when tables are due — the API preset is re-homed', () => {
    // M5b: the API-preset choice is no longer read off the doc; it rides the trigger request from the
    // catalog invocation config. planDispatch is now purely the due-gate → {} means "there is work".
    withMaintainDoc('every_turn', 'preset-9')
    mockCore.chatTemplate.mockReturnValue(template)
    mockCore.dueTables.mockReturnValue(['summary'])
    expect(bridge().planDispatch(scope)).toEqual({})
  })
})

describe('Memory Maintenance bridge — composePrompt shares the preview composer', () => {
  it('substitutes the SAME composeMaintainerMessages output the preview IPC sends, wrapped as prompt', () => {
    withMaintainDoc()
    mockCore.chatTemplate.mockReturnValue(template)
    mockCore.dueTables.mockReturnValue(['summary'])

    const prompt = bridge().composePrompt(scope)

    // The composer is called once with the resolved live cfg + the due-set write-scope directive.
    expect(composeSpy).toHaveBeenCalledTimes(1)
    const [, tmpl, cfg, opts] = composeSpy.mock.calls[0] as [unknown, unknown, { messages: unknown }, { scopeDirective: string }]
    expect(tmpl).toBe(template)
    expect(cfg.messages).toEqual([{ role: 'system', content: 'x' }])
    expect(opts.scopeDirective).toBe('scope:Summary') // only the DUE table's display name
    // Byte-for-byte the composer output, wrapped into PromptMessage segments (no other transformation).
    expect(prompt).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'SCOPE' }] },
      { role: 'user', content: [{ type: 'text', text: 'BODY' }] }
    ])
  })

  it('falls open (undefined) when nothing is due', () => {
    withMaintainDoc()
    mockCore.chatTemplate.mockReturnValue(template)
    mockCore.dueTables.mockReturnValue([])
    expect(bridge().composePrompt(scope)).toBeUndefined()
  })
})

describe('Memory Maintenance bridge — applyResult three-way discrimination', () => {
  const composeThenApply = (raw: unknown, atFloor = scope.floor): void => {
    withMaintainDoc()
    mockCore.chatTemplate.mockReturnValue(template)
    mockCore.dueTables.mockReturnValue(['summary'])
    bridge().composePrompt(scope) // stashes context (due=['summary'], epoch=5, currentFloor=3)
    bridge().applyResult({ ...scope, floor: atFloor }, raw)
  }

  it('NO tag → reports only: no apply, no pointer advance', () => {
    composeThenApply('the model forgot the tag')
    expect(mockCore.applyTableEdit).not.toHaveBeenCalled()
    expect(mockProgress.advanceProgress).not.toHaveBeenCalled()
  })

  it('EMPTY tag → advances the due pointers (compliant "no changes")', () => {
    composeThenApply('<TableEdit></TableEdit>')
    expect(mockCore.applyTableEdit).not.toHaveBeenCalled()
    expect(mockProgress.advanceProgress).toHaveBeenCalledTimes(1)
    // Advances the DUE tables to the floor the model actually read (currentFloor = 4 - 1 = 3).
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('p', 'c1', ['summary'], 3)
  })

  it('EMPTY tag + moved transcript epoch → drops the advance (staleness fence)', () => {
    withMaintainDoc()
    mockCore.chatTemplate.mockReturnValue(template)
    mockCore.dueTables.mockReturnValue(['summary'])
    bridge().composePrompt(scope) // epoch captured at 5
    epochState.value = 9 // a regenerate/edit/swipe landed mid-call
    bridge().applyResult(scope, '<TableEdit></TableEdit>')
    expect(mockProgress.advanceProgress).not.toHaveBeenCalled()
  })

  it('SQL tag → applies via applyTableEdit, scoped + fenced to the compose epoch', () => {
    composeThenApply('<TableEdit>INSERT INTO summary VALUES (1);</TableEdit>')
    expect(mockCore.applyTableEdit).toHaveBeenCalledTimes(1)
    const [, tmpl, sql, opts] = mockCore.applyTableEdit.mock.calls[0] as [
      unknown,
      unknown,
      string,
      { writeScope: string[]; advanceTables: string[]; expectTranscriptEpoch: number; advanceTo: number }
    ]
    expect(tmpl).toBe(template)
    expect(sql).toContain('INSERT INTO summary')
    expect(opts.writeScope).toEqual(['summary'])
    expect(opts.advanceTables).toEqual(['summary'])
    expect(opts.expectTranscriptEpoch).toBe(5)
    expect(opts.advanceTo).toBe(3)
  })

  it('ignores a result whose floor no longer matches the stashed compose (superseded floor)', () => {
    composeThenApply('<TableEdit>INSERT INTO summary VALUES (1);</TableEdit>', 99)
    expect(mockCore.applyTableEdit).not.toHaveBeenCalled()
  })

  it('applies nothing when no compose context was stashed', () => {
    bridge().applyResult({ profileId: 'p', chatId: 'other', floor: 1 }, '<TableEdit>x</TableEdit>')
    expect(mockCore.applyTableEdit).not.toHaveBeenCalled()
    expect(mockProgress.advanceProgress).not.toHaveBeenCalled()
  })
})

describe('createTriggerDispatch — memory gating + result handling', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0))
  const memReq: TriggerDispatchRequest = { profileId: 'p', chatId: 'c1', floor: 7, agent: 'Memory Maintenance' }

  const succeeded = (result: unknown): InvocationOutcome => ({
    invocationId: 'i',
    status: 'succeeded',
    result: result as never,
    sourceRestarts: 0,
    required: false
  })

  const makeBridge = (plan: { apiPresetId?: string } | null) => ({
    planDispatch: vi.fn(() => plan),
    applyResult: vi.fn()
  })

  it('nothing due (null plan) → run is NEVER called: no provider call, no Run Record', async () => {
    const run = vi.fn<(r: InvocationRequest) => Promise<InvocationOutcome>>(() => Promise.resolve(succeeded('x')))
    const mem = makeBridge(null)
    const dispatch = createTriggerDispatch({ run, memoryBridge: () => mem, warn: () => {} })

    dispatch(memReq)
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(mem.applyResult).not.toHaveBeenCalled()
  })

  it('due → runs with the request API-preset option (from invocation config); apply is the runtime seam, not here', async () => {
    const run = vi.fn<(r: InvocationRequest) => Promise<InvocationOutcome>>(() =>
      Promise.resolve(succeeded('<TableEdit></TableEdit>'))
    )
    // M5b: the API preset now comes from the request (the catalog's profile-local invocation config),
    // NOT the bridge plan — the plan is the due-gate only.
    const mem = makeBridge({})
    const dispatch = createTriggerDispatch({ run, memoryBridge: () => mem, warn: () => {} })

    dispatch({ ...memReq, apiPresetId: 'preset-9' })
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].options).toEqual({ apiPresetId: 'preset-9' })
    // The apiPresetId is consumed into options and does NOT leak onto the identity request.
    expect((run.mock.calls[0][0] as { apiPresetId?: string }).apiPresetId).toBeUndefined()
    // Final-review Finding 1: the trigger dispatch no longer applies. Apply is the single-owner
    // completion seam at the composition root (`withMemoryMaintenanceApply`) so it runs for the manual
    // path too and never double-applies here.
    expect(mem.applyResult).not.toHaveBeenCalled()
  })

  it('nothing here calls applyResult even on a cancelled run (apply is not this path\'s job)', async () => {
    const cancelled: InvocationOutcome = { invocationId: 'i', status: 'cancelled', sourceRestarts: 0, required: false }
    const run = vi.fn<(r: InvocationRequest) => Promise<InvocationOutcome>>(() => Promise.resolve(cancelled))
    const mem = makeBridge({})
    const dispatch = createTriggerDispatch({ run, memoryBridge: () => mem, warn: () => {} })

    dispatch(memReq)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(mem.applyResult).not.toHaveBeenCalled()
  })

  it('a non-memory Agent dispatches unchanged and never consults the bridge', async () => {
    const run = vi.fn<(r: InvocationRequest) => Promise<InvocationOutcome>>(() => Promise.resolve(succeeded('x')))
    const mem = makeBridge(null)
    const dispatch = createTriggerDispatch({ run, memoryBridge: () => mem, warn: () => {} })

    dispatch({ profileId: 'p', chatId: 'c1', floor: 7, agent: 'Some Other Agent' })
    await flush()
    expect(mem.planDispatch).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].options).toBeUndefined()
  })
})

describe('withMemoryMaintenanceApply — single-owner apply seam (Finding 1)', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0))
  const succeeded = (result: unknown): InvocationOutcome => ({
    invocationId: 'i',
    status: 'succeeded',
    result: result as never,
    sourceRestarts: 0,
    required: false
  })
  // A minimal base runtime whose `run` resolves to a chosen outcome; only `run` is exercised.
  const fakeBase = (outcome: InvocationOutcome): InvocationRuntime =>
    ({
      run: () => {
        const p = Promise.resolve(outcome) as InvocationPromise
        Object.defineProperty(p, 'invocationId', { value: outcome.invocationId })
        return p
      }
    }) as unknown as InvocationRuntime
  const memReq: InvocationRequest = { profileId: 'p', chatId: 'c1', floor: 7, agent: 'Memory Maintenance' }

  it('applies once after ANY successful Memory Maintenance run (trigger OR manual funnel here)', async () => {
    const applyResult = vi.fn()
    const runtime = withMemoryMaintenanceApply(fakeBase(succeeded('<TableEdit></TableEdit>')), {
      bridge: () => ({ applyResult }),
      warn: () => {}
    })
    await runtime.run(memReq)
    await flush()
    expect(applyResult).toHaveBeenCalledTimes(1)
    expect(applyResult).toHaveBeenCalledWith(
      { profileId: 'p', chatId: 'c1', floor: 7 },
      '<TableEdit></TableEdit>'
    )
  })

  it('does NOT apply on a failed or cancelled run', async () => {
    const applyResult = vi.fn()
    const failed: InvocationOutcome = {
      invocationId: 'i',
      status: 'failed',
      failure: { code: 'X', message: 'boom', retryable: false },
      sourceRestarts: 0,
      required: false
    }
    const runtime = withMemoryMaintenanceApply(fakeBase(failed), {
      bridge: () => ({ applyResult }),
      warn: () => {}
    })
    await runtime.run(memReq)
    await flush()
    expect(applyResult).not.toHaveBeenCalled()
  })

  it('never consults the bridge for a non-memory Agent', async () => {
    const applyResult = vi.fn()
    const runtime = withMemoryMaintenanceApply(fakeBase(succeeded('x')), {
      bridge: () => ({ applyResult }),
      warn: () => {}
    })
    await runtime.run({ ...memReq, agent: 'Some Other Agent' })
    await flush()
    expect(applyResult).not.toHaveBeenCalled()
  })
})
