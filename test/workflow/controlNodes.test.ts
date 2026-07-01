import { describe, it, expect } from 'vitest'
import {
  evalPredicate,
  PREDICATE_OPS,
  controlIf,
  controlSwitch,
  controlWhen
} from '../../src/main/services/nodes/builtin/controlNodes'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'

// --- test harness ---------------------------------------------------------
// Map-backed ctx.getNodeState/setNodeState mirrors the real per-(chat,node) scratchpad
// (see nodeStateService.ts) closely enough for unit-level node tests (Task 3 pattern).
const makeCtx = (): RunContext => {
  const store = new Map<string, unknown>()
  return {
    signal: new AbortController().signal,
    streamMain: () => {},
    emitPanel: () => {},
    getNodeState: (nodeId) => store.get(nodeId),
    setNodeState: (nodeId, value) => {
      store.set(nodeId, value)
    }
  }
}

/** Mirrors the engine's node.config parsing (workflowEngine.ts): parse raw config through
 *  the impl's configSchema before handing it to run(), as NodeMeta. */
const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown>) => ({
  id,
  config: impl.configSchema!.parse(rawConfig) as Record<string, unknown>
})

describe('evalPredicate', () => {
  it('eq: deep JSON equality, including objects', () => {
    expect(evalPredicate(1, 'eq', 1)).toBe(true)
    expect(evalPredicate('a', 'eq', 'b')).toBe(false)
    expect(evalPredicate({ a: 1, b: [1, 2] }, 'eq', { a: 1, b: [1, 2] })).toBe(true)
    expect(evalPredicate({ a: 1 }, 'eq', { a: 2 })).toBe(false)
    expect(evalPredicate(null, 'eq', undefined)).toBe(true)
  })

  it('neq: negation of eq deep equality', () => {
    expect(evalPredicate(1, 'neq', 2)).toBe(true)
    expect(evalPredicate({ a: 1 }, 'neq', { a: 1 })).toBe(false)
  })

  it('gt/gte/lt/lte: numeric coercion, including numeric strings', () => {
    expect(evalPredicate(5, 'gt', 3)).toBe(true)
    expect(evalPredicate(3, 'gt', 5)).toBe(false)
    expect(evalPredicate('5', 'gt', '3')).toBe(true)
    expect(evalPredicate(5, 'gte', 5)).toBe(true)
    expect(evalPredicate(4, 'gte', 5)).toBe(false)
    expect(evalPredicate(3, 'lt', 5)).toBe(true)
    expect(evalPredicate('3', 'lt', '5')).toBe(true)
    expect(evalPredicate(5, 'lte', 5)).toBe(true)
    expect(evalPredicate(6, 'lte', 5)).toBe(false)
  })

  it('truthy/falsy', () => {
    expect(evalPredicate('x', 'truthy')).toBe(true)
    expect(evalPredicate('', 'truthy')).toBe(false)
    expect(evalPredicate(0, 'falsy')).toBe(true)
    expect(evalPredicate(1, 'falsy')).toBe(false)
  })

  it('contains: string subject substring match', () => {
    expect(evalPredicate('hello world', 'contains', 'world')).toBe(true)
    expect(evalPredicate('hello world', 'contains', 'xyz')).toBe(false)
  })

  it('contains: array subject deep-equality element match', () => {
    expect(evalPredicate([1, { a: 1 }, 3], 'contains', { a: 1 })).toBe(true)
    expect(evalPredicate([1, 2, 3], 'contains', 4)).toBe(false)
  })

  it('contains: anything else is false', () => {
    expect(evalPredicate(42, 'contains', 4)).toBe(false)
    expect(evalPredicate({ a: 1 }, 'contains', 'a')).toBe(false)
  })

  it('PREDICATE_OPS lists exactly the supported ops', () => {
    expect(PREDICATE_OPS).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'truthy',
      'falsy',
      'contains'
    ])
  })
})

describe('control.if', () => {
  it('descriptor: value:Any + when:Signal inputs, then/else Signal outputs', () => {
    expect(controlIf.type).toBe('control.if')
    expect(controlIf.inputs).toEqual([
      { name: 'value', type: 'Any' },
      { name: 'when', type: 'Signal' }
    ])
    expect(controlIf.outputs).toEqual([
      { name: 'then', type: 'Signal' },
      { name: 'else', type: 'Signal' }
    ])
  })

  it('fires then when the predicate is true', async () => {
    const ctx = makeCtx()
    const node = meta(controlIf, 'n1', { op: 'eq', value: 5 })
    const res = await controlIf.run(ctx, { value: 5 }, node)
    expect(res.signals).toEqual(['then'])
  })

  it('fires else when the predicate is false', async () => {
    const ctx = makeCtx()
    const node = meta(controlIf, 'n1', { op: 'eq', value: 5 })
    const res = await controlIf.run(ctx, { value: 6 }, node)
    expect(res.signals).toEqual(['else'])
  })

  it('resolves subject via config.path against inputs.value', async () => {
    const ctx = makeCtx()
    const node = meta(controlIf, 'n1', { path: 'stat_data.hp', op: 'lte', value: 0 })
    const dead = await controlIf.run(ctx, { value: { stat_data: { hp: 0 } } }, node)
    expect(dead.signals).toEqual(['then'])
    const alive = await controlIf.run(ctx, { value: { stat_data: { hp: 10 } } }, node)
    expect(alive.signals).toEqual(['else'])
  })
})

describe('control.switch', () => {
  it('descriptor: case1-case4 + default Signal outputs', () => {
    expect(controlSwitch.type).toBe('control.switch')
    expect(controlSwitch.inputs).toEqual([
      { name: 'value', type: 'Any' },
      { name: 'when', type: 'Signal' }
    ])
    expect(controlSwitch.outputs).toEqual([
      { name: 'case1', type: 'Signal' },
      { name: 'case2', type: 'Signal' },
      { name: 'case3', type: 'Signal' },
      { name: 'case4', type: 'Signal' },
      { name: 'default', type: 'Signal' }
    ])
  })

  it('fires the first matching case', async () => {
    const ctx = makeCtx()
    const node = meta(controlSwitch, 'n1', { cases: ['a', 'b', 'c'] })
    const res = await controlSwitch.run(ctx, { value: 'b' }, node)
    expect(res.signals).toEqual(['case2'])
  })

  it('fires the FIRST matching case when duplicates exist', async () => {
    const ctx = makeCtx()
    const node = meta(controlSwitch, 'n1', { cases: ['x', 'x'] })
    const res = await controlSwitch.run(ctx, { value: 'x' }, node)
    expect(res.signals).toEqual(['case1'])
  })

  it('fires default when no case matches', async () => {
    const ctx = makeCtx()
    const node = meta(controlSwitch, 'n1', { cases: ['a', 'b'] })
    const res = await controlSwitch.run(ctx, { value: 'z' }, node)
    expect(res.signals).toEqual(['default'])
  })

  it('matches cases by deep JSON equality', async () => {
    const ctx = makeCtx()
    const node = meta(controlSwitch, 'n1', { cases: [{ a: 1 }, { a: 2 }] })
    const res = await controlSwitch.run(ctx, { value: { a: 2 } }, node)
    expect(res.signals).toEqual(['case2'])
  })
})

describe('control.when', () => {
  it('descriptor: single fire Signal output', () => {
    expect(controlWhen.type).toBe('control.when')
    expect(controlWhen.inputs).toEqual([
      { name: 'value', type: 'Any' },
      { name: 'when', type: 'Signal' }
    ])
    expect(controlWhen.outputs).toEqual([{ name: 'fire', type: 'Signal' }])
  })

  it('normal predicate ops behave like a single-output if', async () => {
    const ctx = makeCtx()
    const node = meta(controlWhen, 'n1', { op: 'gt', value: 10 })
    const fires = await controlWhen.run(ctx, { value: 15 }, node)
    expect(fires.signals).toEqual(['fire'])
    const doesNotFire = await controlWhen.run(ctx, { value: 5 }, node)
    expect(doesNotFire.signals).toEqual([])
  })

  it('changed: fires on first sight and stores the value', async () => {
    const ctx = makeCtx()
    const node = meta(controlWhen, 'n1', { op: 'changed' })
    expect(ctx.getNodeState('n1')).toBeUndefined()
    const res = await controlWhen.run(ctx, { value: 'a' }, node)
    expect(res.signals).toEqual(['fire'])
    expect(ctx.getNodeState('n1')).toEqual({ last: JSON.stringify('a') })
  })

  it('changed: same value again does not fire and does not overwrite state', async () => {
    const ctx = makeCtx()
    const node = meta(controlWhen, 'n1', { op: 'changed' })
    await controlWhen.run(ctx, { value: 'a' }, node)
    const stateAfterFirst = ctx.getNodeState('n1')
    const res = await controlWhen.run(ctx, { value: 'a' }, node)
    expect(res.signals).toEqual([])
    expect(ctx.getNodeState('n1')).toEqual(stateAfterFirst)
  })

  it('changed: a changed value fires again and updates state', async () => {
    const ctx = makeCtx()
    const node = meta(controlWhen, 'n1', { op: 'changed' })
    await controlWhen.run(ctx, { value: 'a' }, node)
    const res = await controlWhen.run(ctx, { value: 'b' }, node)
    expect(res.signals).toEqual(['fire'])
    expect(ctx.getNodeState('n1')).toEqual({ last: JSON.stringify('b') })
  })

  it('resolves subject via config.path against inputs.value for changed', async () => {
    const ctx = makeCtx()
    const node = meta(controlWhen, 'n1', { path: 'stat_data.hp', op: 'changed' })
    const first = await controlWhen.run(ctx, { value: { stat_data: { hp: 10 } } }, node)
    expect(first.signals).toEqual(['fire'])
    const same = await controlWhen.run(ctx, { value: { stat_data: { hp: 10 } } }, node)
    expect(same.signals).toEqual([])
    const changed = await controlWhen.run(ctx, { value: { stat_data: { hp: 9 } } }, node)
    expect(changed.signals).toEqual(['fire'])
  })
})
