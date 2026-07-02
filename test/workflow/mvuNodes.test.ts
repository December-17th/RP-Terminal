import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'

const applyVariableOpsMock = vi.fn()
const getAllFloorsMock = vi.fn()

vi.mock('../../src/main/services/generation/varsWrite', () => ({
  applyVariableOps: (...args: unknown[]) => applyVariableOpsMock(...args)
}))

vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: (...args: unknown[]) => getAllFloorsMock(...args)
}))

const { toPointer, mvuSet } = await import('../../src/main/services/nodes/builtin/mvuNodes')

// --- test harness ---------------------------------------------------------
// Map-backed ctx.getNodeState/setNodeState mirrors the real per-(chat,node) scratchpad
// (see nodeStateService.ts) closely enough for unit-level node tests (controlNodes.test.ts pattern).
const makeCtx = (overrides: Partial<RunContext> = {}): RunContext => {
  const store = new Map<string, unknown>()
  return {
    signal: new AbortController().signal,
    streamMain: () => {},
    emitPanel: () => {},
    getNodeState: (nodeId) => store.get(nodeId),
    setNodeState: (nodeId, value) => {
      store.set(nodeId, value)
    },
    profileId: 'p1',
    chatId: 'c1',
    ...overrides
  }
}

/** Mirrors the engine's node.config parsing (workflowEngine.ts): parse raw config through
 *  the impl's configSchema before handing it to run(), as NodeMeta. */
const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown>) => ({
  id,
  config: impl.configSchema!.parse(rawConfig) as Record<string, unknown>
})

describe('toPointer', () => {
  it('converts a plain dot path', () => {
    expect(toPointer('a.b')).toBe('/a/b')
  })

  it('converts a bracket array-index path', () => {
    expect(toPointer('a[0].b')).toBe('/a/0/b')
  })

  it('escapes ~ as ~0', () => {
    expect(toPointer('k~x')).toBe('/k~0x')
  })

  it('escapes / as ~1', () => {
    expect(toPointer('k/x')).toBe('/k~1x')
  })
})

describe('mvu.set', () => {
  beforeEach(() => {
    applyVariableOpsMock.mockReset()
    getAllFloorsMock.mockReset()
  })

  // context-epochs plan §1: mvu.set gained a `done: Any` ordering-only output (wire it into a
  // downstream context.refresh's `after` port). It's emitted only on the path that COMPLETED a write.
  it('descriptor: inputs value:Any + when:Signal, output done:Any', () => {
    expect(mvuSet.type).toBe('mvu.set')
    expect(mvuSet.inputs).toEqual([
      { name: 'value', type: 'Any' },
      { name: 'when', type: 'Signal' }
    ])
    expect(mvuSet.outputs).toEqual([{ name: 'done', type: 'Any' }])
  })

  it('writes the config value to the latest floor via applyVariableOps', async () => {
    getAllFloorsMock.mockReturnValue([{ floor: 0 }, { floor: 1 }])
    const ctx = makeCtx()
    const node = meta(mvuSet, 'n1', { path: 'hp', value: 5 })
    const res = await mvuSet.run(ctx, {}, node)
    expect(applyVariableOpsMock).toHaveBeenCalledWith('p1', 'c1', 1, [
      { op: 'replace', path: '/hp', value: 5 }
    ])
    expect(res).toEqual({ outputs: { done: true } })
  })

  it('wired input value overrides the config value', async () => {
    getAllFloorsMock.mockReturnValue([{ floor: 0 }, { floor: 1 }])
    const ctx = makeCtx()
    const node = meta(mvuSet, 'n1', { path: 'hp', value: 5 })
    await mvuSet.run(ctx, { value: 9 }, node)
    expect(applyVariableOpsMock).toHaveBeenCalledWith('p1', 'c1', 1, [
      { op: 'replace', path: '/hp', value: 9 }
    ])
  })

  it('falls back to config value when the input is unwired (undefined)', async () => {
    getAllFloorsMock.mockReturnValue([{ floor: 0 }])
    const ctx = makeCtx()
    const node = meta(mvuSet, 'n1', { path: 'hp', value: 5 })
    await mvuSet.run(ctx, { value: undefined }, node)
    expect(applyVariableOpsMock).toHaveBeenCalledWith('p1', 'c1', 0, [
      { op: 'replace', path: '/hp', value: 5 }
    ])
  })

  it('a wired input value of null WINS over the config value', async () => {
    getAllFloorsMock.mockReturnValue([{ floor: 0 }])
    const ctx = makeCtx()
    const node = meta(mvuSet, 'n1', { path: 'hp', value: 5 })
    await mvuSet.run(ctx, { value: null }, node)
    expect(applyVariableOpsMock).toHaveBeenCalledWith('p1', 'c1', 0, [
      { op: 'replace', path: '/hp', value: null }
    ])
  })

  it('no value at all (input unwired, config value omitted): skips the write entirely', async () => {
    // Without this guard the node writes `{ op: 'replace', value: undefined }` — a confusing
    // key-vanishes-on-persist no-value write (review follow-up on PR #26).
    getAllFloorsMock.mockReturnValue([{ floor: 0 }])
    const ctx = makeCtx()
    const node = meta(mvuSet, 'n1', { path: 'hp' })
    const res = await mvuSet.run(ctx, {}, node)
    expect(applyVariableOpsMock).not.toHaveBeenCalled()
    // no-value path writes nothing → emits nothing (dead `done` edge is correct).
    expect(res).toEqual({ outputs: {} })
  })

  it('no floors: does not call applyVariableOps and returns { outputs: {} } without throwing', async () => {
    getAllFloorsMock.mockReturnValue([])
    const ctx = makeCtx()
    const node = meta(mvuSet, 'n1', { path: 'hp', value: 5 })
    const res = await mvuSet.run(ctx, {}, node)
    expect(applyVariableOpsMock).not.toHaveBeenCalled()
    // nothing written (no floor) → emits nothing.
    expect(res).toEqual({ outputs: {} })
  })
})
