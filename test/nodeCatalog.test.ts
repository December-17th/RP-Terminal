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
      'memory.recall',
      'prompt.assemble',
      'llm.sample',
      'parse.response',
      'apply.state',
      'output.writeFloor',
      'memory.compact',
      'control.if',
      'control.switch',
      'control.when',
      'text.template',
      'prompt.messages',
      'merge.messages',
      'mvu.set'
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

  it('returns plain JSON-serializable data (survives a structured-clone round trip)', () => {
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
  })
})
