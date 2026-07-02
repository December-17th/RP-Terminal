import { describe, it, expect } from 'vitest'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { topoOrder } from '../../src/shared/workflow/graph'
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

  it('compacts memory only AFTER the floor is written (owner requirement: action → recall → response → write → compact)', () => {
    // The ordering is a data edge, not just the phase rule — visible in the editor and
    // guaranteed by topo order.
    expect(DEFAULT_GRAPH.edges).toContainEqual({
      from: { node: 'write', port: 'floor' },
      to: { node: 'compact', port: 'floor' }
    })
    const order = topoOrder(DEFAULT_GRAPH)
    expect(order.indexOf('compact')).toBeGreaterThan(order.indexOf('write'))
  })
})
