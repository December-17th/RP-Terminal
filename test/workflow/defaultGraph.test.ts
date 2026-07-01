import { describe, it, expect } from 'vitest'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { DEFAULT_GRAPH } from '../../src/main/services/nodes/builtin/defaultGraph'

describe('DEFAULT_GRAPH', () => {
  it('validates against the builtin registry', () => {
    expect(validateWorkflow(DEFAULT_GRAPH, builtinRegistry.descriptors())).toEqual({ ok: true })
  })

  it('has exactly one main-output node, and it is write', () => {
    const mains = DEFAULT_GRAPH.nodes.filter((n) => n.isMainOutput)
    expect(mains).toHaveLength(1)
    expect(mains[0].id).toBe('write')
  })
})
