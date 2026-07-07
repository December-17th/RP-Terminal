import { describe, it, expect } from 'vitest'
import { listNodeTypes } from '../src/main/services/nodes/catalog'

describe('listNodeTypes', () => {
  const catalog = listNodeTypes()
  const byType = new Map(catalog.map((n) => [n.type, n]))

  it('covers every builtin node type exactly once', () => {
    const types = catalog.map((n) => n.type)
    expect(new Set(types).size).toBe(types.length)
    for (const t of [
      'input.context',
      'prompt.assemble',
      'llm.sample',
      'parse.response',
      'apply.state',
      'output.writeFloor',
      'control.if',
      'control.switch',
      'control.when',
      'text.template',
      'prompt.messages',
      'merge.messages',
      'mvu.set',
      'util.log',
      'tool.startCombat',
      'tool.startDuel',
      'tool.lorebookSearch',
      'vars.get',
      'vars.save',
      'context.history',
      'context.card',
      'context.persona',
      'subgraph.input',
      'subgraph.output',
      'subgraph.call'
    ]) {
      expect(byType.has(t)).toBe(true)
    }
  })

  it('carries ports and the main-output capability flag', () => {
    const write = byType.get('output.writeFloor')!
    expect(write.isMainOutputCapable).toBe(true)
    expect(write.inputs).toContainEqual({ name: 'variables', type: 'Vars' })
    const llm = byType.get('llm.sample')!
    expect(llm.inputs).toContainEqual({ name: 'when', type: 'Signal' })
  })

  it('serializes configSchema to JSON Schema for configured nodes, omits it otherwise', () => {
    const tpl = byType.get('text.template')!
    expect(tpl.configSchema).toBeDefined()
    const props = (tpl.configSchema as any).properties
    expect(props.template).toEqual({ type: 'string' })
    expect(byType.get('input.context')!.configSchema).toBeUndefined()
  })

  it('surfaces the `isTrigger` flag for trigger node types (agent-memory-ux WP-A)', () => {
    // Trigger roots opt in via the descriptor flag; the renderer keys its agent detection off this.
    expect(byType.get('trigger.cadence')!.isTrigger).toBe(true)
    expect(byType.get('trigger.state')!.isTrigger).toBe(true)
    expect(byType.get('trigger.manual')!.isTrigger).toBe(true)
    // A non-trigger node omits it entirely (undefined, not false).
    expect(byType.get('input.context')!.isTrigger).toBeUndefined()
    expect(byType.get('llm.sample')!.isTrigger).toBeUndefined()
  })

  it('surfaces `promptFields` for the prompt-bearing node types (agent-memory-ux WP-A)', () => {
    expect(byType.get('agent.llm')!.promptFields).toEqual(['messages'])
    expect(byType.get('text.template')!.promptFields).toEqual(['template'])
    // A node with no authored prompt omits it.
    expect(byType.get('input.context')!.promptFields).toBeUndefined()
  })

  it('carries `dynamicEnum` only when a node declares it (none in WP-A; control.mode lands in WP-B)', () => {
    // The catalog SURFACE exists now; no built-in stamps it yet, so it is absent everywhere.
    expect(catalog.every((n) => n.dynamicEnum === undefined)).toBe(true)
  })

  it('returns plain JSON-serializable data (survives a structured-clone round trip)', () => {
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
  })
})
