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

  it('compacts memory only AFTER the floor is written (owner requirement: action → recall → response → write → gate → extract → write memories)', () => {
    // The ordering is a data edge, not just the phase rule — visible in the editor and
    // guaranteed by topo order.
    expect(DEFAULT_GRAPH.edges).toContainEqual({
      from: { node: 'write', port: 'floor' },
      to: { node: 'gate', port: 'floor' }
    })
    const order = topoOrder(DEFAULT_GRAPH)
    expect(order.indexOf('gate')).toBeGreaterThan(order.indexOf('write'))
    expect(order.indexOf('extract')).toBeGreaterThan(order.indexOf('gate'))
    expect(order.indexOf('memwrite')).toBeGreaterThan(order.indexOf('extract'))
  })

  it('carries the spec §6 reference error wiring: extract/write errors → log nodes', () => {
    expect(DEFAULT_GRAPH.edges).toContainEqual({
      from: { node: 'extract', port: 'error' },
      to: { node: 'log-extract', port: 'value' }
    })
    expect(DEFAULT_GRAPH.edges).toContainEqual({
      from: { node: 'memwrite', port: 'error' },
      to: { node: 'log-write', port: 'value' }
    })
    // The main llm's error stays deliberately UNWIRED — a hard generation failure surfaces
    // as a retryable failed turn (spec §6/§10).
    expect(DEFAULT_GRAPH.edges.some((e) => e.from.node === 'llm' && e.from.port === 'error')).toBe(
      false
    )
  })

  it('memory.write runs only when extract succeeded (Signal-gated, not just data-fed)', () => {
    expect(DEFAULT_GRAPH.edges).toContainEqual({
      from: { node: 'extract', port: 'done' },
      to: { node: 'memwrite', port: 'when' }
    })
  })
})
