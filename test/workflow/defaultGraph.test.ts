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

  it('no longer references the removed episodic-memory nodes', () => {
    // The engine was retired (SQL-table-memory overhaul): the default graph ends at write,
    // with no recall producer and no post-write compaction chain.
    expect(DEFAULT_GRAPH.nodes.some((n) => n.type.startsWith('memory.'))).toBe(false)
    // assemble's `block` input is left unwired (empty memory tail) — no edge feeds it.
    expect(DEFAULT_GRAPH.edges.some((e) => e.to.node === 'assemble' && e.to.port === 'block')).toBe(
      false
    )
  })

  it('the main llm error stays deliberately UNWIRED (a hard failure = a retryable failed turn)', () => {
    // spec §6/§10 — no error branch on the main sample in the default graph.
    expect(DEFAULT_GRAPH.edges.some((e) => e.from.node === 'llm' && e.from.port === 'error')).toBe(
      false
    )
  })
})
