import { describe, it, expect, vi, beforeEach } from 'vitest'

// context.refresh (context-epochs plan §1): re-acquires the per-turn GenContext bundle MID-GRAPH,
// so a branch that wrote floor variables (vars.save / mvu.set) upstream is reflected by a FRESH
// buildGenContext read. Paired with the `done: Any` ordering outputs now on vars.save / mvu.set.

// A tiny mutable "floor store" the mocked buildGenContext reads from, so a vars.save-style write
// followed by a refresh yields a bundle whose workingVars reflect the write.
const store = vi.hoisted(() => ({ vars: {} as Record<string, unknown> }))

const genContextSvc = vi.hoisted(() => ({
  // Snapshot the CURRENT store state into a fresh bundle (deep-copied — a real buildGenContext
  // returns a wholly new object each call, JSON.parse(JSON.stringify(...)) of the latest floor).
  buildGenContext: vi.fn((profileId: string, chatId: string, userAction: string) => ({
    profileId,
    chatId,
    userAction,
    workingVars: JSON.parse(JSON.stringify(store.vars))
  }))
}))
vi.mock('../../src/main/services/generation/genContext', () => genContextSvc)

const floorSvc = vi.hoisted(() => ({
  getAllFloors: vi.fn(),
  saveFloor: vi.fn(),
  getFloor: vi.fn()
}))
vi.mock('../../src/main/services/floorService', () => floorSvc)

const chatVarsSvc = vi.hoisted(() => ({
  getChatCardVars: vi.fn(),
  setChatCardVars: vi.fn()
}))
vi.mock('../../src/main/services/chatCardVarsService', () => chatVarsSvc)

const applyVariableOpsMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/services/generation/varsWrite', () => ({
  applyVariableOps: (...args: unknown[]) => applyVariableOpsMock(...args)
}))

import { contextRefresh } from '../../src/main/services/nodes/builtin/generationNodes'
import { varsSave } from '../../src/main/services/nodes/builtin/varsNodes'
import { mvuSet } from '../../src/main/services/nodes/builtin/mvuNodes'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { WorkflowDoc } from '../../src/shared/workflow/types'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {},
  profileId: 'p1',
  chatId: 'c1',
  userAction: 'go'
}

const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown> = {}) => ({
  id,
  config: impl.configSchema ? (impl.configSchema.parse(rawConfig) as Record<string, unknown>) : {}
})

beforeEach(() => {
  store.vars = {}
  genContextSvc.buildGenContext.mockClear()
  floorSvc.getAllFloors.mockReset()
  floorSvc.saveFloor.mockReset()
  chatVarsSvc.getChatCardVars.mockReset()
  chatVarsSvc.setChatCardVars.mockReset()
  applyVariableOpsMock.mockReset()
})

describe('context.refresh descriptor', () => {
  it('gen:Context + after:Any inputs; gen:Context output; NOT Signal after', () => {
    expect(contextRefresh.type).toBe('context.refresh')
    expect(contextRefresh.inputs).toEqual([
      { name: 'gen', type: 'Context' },
      { name: 'after', type: 'Any' }
    ])
    expect(contextRefresh.outputs).toEqual([{ name: 'gen', type: 'Context' }])
    // The `after` port MUST be Any (never Signal) so a dead ordering edge doesn't gate the refresh
    // off via the engine's every-signal-in-dead rule.
    expect(contextRefresh.inputs.find((p) => p.name === 'after')?.type).not.toBe('Signal')
  })
})

describe('context.refresh run', () => {
  it('returns a FRESH bundle re-read from profileId/chatId/userAction on the original gen', () => {
    // issue 12: context.refresh carries the ORIGINAL bundle's generationType into the fresh read.
    const orig = {
      profileId: 'pX',
      chatId: 'cX',
      userAction: 'act',
      generationType: 'swipe',
      workingVars: {}
    }
    const r = contextRefresh.run(ctx, { gen: orig, after: true }, meta(contextRefresh, 'n1'))
    expect(genContextSvc.buildGenContext).toHaveBeenCalledWith('pX', 'cX', 'act', 'swipe')
    const fresh = (r.outputs as { gen: unknown }).gen
    expect(fresh).not.toBe(orig)
  })

  it('a vars.save write then refresh: the fresh bundle reflects the write; original is untouched', () => {
    // Original snapshot taken before the write.
    const orig = genContextSvc.buildGenContext('p1', 'c1', 'go') as {
      profileId: string
      chatId: string
      userAction: string
      workingVars: Record<string, unknown>
    }
    expect(orig.workingVars).toEqual({})

    // A session-scope vars.save write (simplest store to model) — emits `done`.
    chatVarsSvc.getChatCardVars.mockReturnValue({})
    chatVarsSvc.setChatCardVars.mockImplementation((_p, _c, kv) => {
      store.vars = kv
    })
    const save = varsSave.run(
      ctx,
      { gen: orig, value: 7 },
      meta(varsSave, 'w1', { scope: 'session', path: 'world.month' })
    )
    expect(save.outputs).toEqual({ done: true })

    // Refresh, sequenced after the write via `after`.
    const r = contextRefresh.run(ctx, { gen: orig, after: save.outputs!.done }, meta(contextRefresh, 'n1'))
    const fresh = (r.outputs as { gen: { workingVars: Record<string, unknown> } }).gen
    expect(fresh.workingVars).toEqual({ world: { month: 7 } })
    // ORIGINAL bundle object is unchanged (context epochs: refresh is a new read, not a mutation).
    expect(orig.workingVars).toEqual({})
  })
})

describe('vars.save `done` ordering output', () => {
  it('emits done:true on a completed session write', () => {
    chatVarsSvc.getChatCardVars.mockReturnValue({})
    const r = varsSave.run(
      ctx,
      { gen: ctx, value: 1 },
      meta(varsSave, 'w1', { scope: 'session', path: 'a' })
    )
    expect(r.outputs).toEqual({ done: true })
  })

  it('emits done:true on a completed floor write', () => {
    floorSvc.getAllFloors.mockReturnValue([{ floor: 0, variables: {} }])
    const gen = { profileId: 'p1', chatId: 'c1' }
    const r = varsSave.run(ctx, { gen, value: 'v' }, meta(varsSave, 'w1', { path: 'custom.note' }))
    expect(r.outputs).toEqual({ done: true })
    expect(floorSvc.saveFloor).toHaveBeenCalledTimes(1)
  })

  it('value === undefined emits NOTHING (dead done edge is correct)', () => {
    const r = varsSave.run(ctx, { gen: ctx, value: undefined }, meta(varsSave, 'w1', { path: 'a' }))
    expect(r.outputs).toEqual({})
  })

  it('no floors: floor write skipped, emits nothing', () => {
    floorSvc.getAllFloors.mockReturnValue([])
    const gen = { profileId: 'p1', chatId: 'c1' }
    const r = varsSave.run(ctx, { gen, value: 'v' }, meta(varsSave, 'w1', { path: 'custom.note' }))
    expect(r.outputs).toEqual({})
    expect(floorSvc.saveFloor).not.toHaveBeenCalled()
  })

  it('declares done:Any before error:Error', () => {
    expect(varsSave.outputs).toEqual([
      { name: 'done', type: 'Any' },
      { name: 'error', type: 'Error' }
    ])
  })
})

describe('mvu.set `done` ordering output', () => {
  it('emits done:true after a completed write', async () => {
    floorSvc.getAllFloors.mockReturnValue([{ floor: 3 }])
    const r = await mvuSet.run(ctx, { value: 5 }, meta(mvuSet, 'm1', { path: 'hp', value: 5 }))
    expect(r.outputs).toEqual({ done: true })
    expect(applyVariableOpsMock).toHaveBeenCalled()
  })

  it('no-value path emits nothing (nothing written)', async () => {
    const r = await mvuSet.run(ctx, {}, meta(mvuSet, 'm1', { path: 'hp' }))
    expect(r.outputs).toEqual({})
    expect(applyVariableOpsMock).not.toHaveBeenCalled()
  })

  it('no floors: emits nothing', async () => {
    floorSvc.getAllFloors.mockReturnValue([])
    const r = await mvuSet.run(ctx, { value: 5 }, meta(mvuSet, 'm1', { path: 'hp' }))
    expect(r.outputs).toEqual({})
    expect(applyVariableOpsMock).not.toHaveBeenCalled()
  })

  it('declares done:Any output', () => {
    expect(mvuSet.outputs).toEqual([{ name: 'done', type: 'Any' }])
  })
})

describe('context.refresh — engine-level (write branch gated OFF still refreshes)', () => {
  // A source produces the ORIGINAL gen (live edge into refresh.gen). A gated write branch is
  // signal-gated off, so its `done` edge into refresh.after is DEAD — but refresh MUST still run
  // (its live gen edge keeps it alive; `after` is Any, not Signal). The sink receives the fresh gen.
  const src: NodeImpl = {
    type: 't.src',
    title: 'src',
    inputs: [],
    outputs: [{ name: 'gen', type: 'Context' }],
    run: () => ({
      outputs: { gen: { profileId: 'p1', chatId: 'c1', userAction: 'go', generationType: 'quiet' } }
    })
  }
  const gate: NodeImpl = {
    type: 't.gate',
    title: 'gate',
    inputs: [],
    outputs: [{ name: 'fire', type: 'Signal' }],
    run: () => ({ signals: [] }) // never fires — the write branch below is gated OFF
  }
  const write: NodeImpl = {
    type: 't.write',
    title: 'write',
    inputs: [{ name: 'when', type: 'Signal' }],
    outputs: [{ name: 'done', type: 'Any' }],
    run: () => ({ outputs: { done: true } })
  }
  const sink: NodeImpl = {
    type: 't.sink',
    title: 'sink',
    inputs: [{ name: 'gen', type: 'Context' }],
    outputs: [{ name: 'seen', type: 'Any' }],
    isMainOutputCapable: true,
    run: (_c, inputs) => ({ outputs: { seen: inputs.gen } })
  }
  const reg = createRegistry([src, gate, write, sink, contextRefresh])

  const doc: WorkflowDoc = {
    id: 'w',
    name: 'w',
    version: 1,
    schemaVersion: 1,
    nodes: [
      { id: 's', type: 't.src' },
      { id: 'g', type: 't.gate' },
      { id: 'w', type: 't.write' },
      { id: 'r', type: 'context.refresh' },
      { id: 'k', type: 't.sink', isMainOutput: true }
    ],
    edges: [
      { from: { node: 's', port: 'gen' }, to: { node: 'r', port: 'gen' } },
      { from: { node: 'g', port: 'fire' }, to: { node: 'w', port: 'when' } },
      { from: { node: 'w', port: 'done' }, to: { node: 'r', port: 'after' } },
      { from: { node: 'r', port: 'gen' }, to: { node: 'k', port: 'gen' } }
    ]
  }

  it('refresh runs despite the dead `after` edge; sink receives the fresh gen', async () => {
    const runCtx: RunContext = {
      signal: new AbortController().signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }
    const res = await runWorkflow(doc, reg, runCtx)
    expect(res.traces.find((t) => t.nodeId === 'w')?.status).toBe('skipped')
    expect(res.traces.find((t) => t.nodeId === 'r')?.status).toBe('ran')
    const seen = res.outputs.get('k')?.seen as { userAction: string }
    // The sink saw a FRESH bundle (built by the mocked buildGenContext from src's gen).
    expect(seen.userAction).toBe('go')
    // issue 12: the original bundle's generationType rides into the fresh read.
    expect(genContextSvc.buildGenContext).toHaveBeenCalledWith('p1', 'c1', 'go', 'quiet')
  })
})
