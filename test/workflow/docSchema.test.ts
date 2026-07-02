import { describe, it, expect } from 'vitest'
import { parseWorkflowDoc } from '../../src/shared/workflow/docSchema'
import { DEFAULT_GRAPH } from '../../src/main/services/nodes/builtin/defaultGraph'

const minimal = {
  id: 'w1',
  name: 'My Flow',
  version: 1,
  schemaVersion: 1,
  nodes: [{ id: 'n1', type: 'input.context', isMainOutput: true }],
  edges: []
}

describe('parseWorkflowDoc', () => {
  it('accepts a minimal structurally-valid doc', () => {
    const r = parseWorkflowDoc(minimal)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.name).toBe('My Flow')
  })

  it('accepts the built-in default graph (round-trip safety)', () => {
    expect(parseWorkflowDoc(JSON.parse(JSON.stringify(DEFAULT_GRAPH))).ok).toBe(true)
  })

  it('accepts optional node fields (config, position, panel)', () => {
    const r = parseWorkflowDoc({
      ...minimal,
      nodes: [
        {
          id: 'n1',
          type: 'text.template',
          config: { template: 'hi' },
          position: { x: 10, y: 20 },
          panel: { show: true, label: 'Plan' },
          isMainOutput: true
        }
      ]
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a wrong schemaVersion with a readable error', () => {
    const r = parseWorkflowDoc({ ...minimal, schemaVersion: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('schemaVersion')
  })

  it('rejects non-object input, missing nodes, and malformed edges', () => {
    expect(parseWorkflowDoc('nope').ok).toBe(false)
    expect(parseWorkflowDoc({ ...minimal, nodes: undefined }).ok).toBe(false)
    expect(parseWorkflowDoc({ ...minimal, edges: [{ from: { node: 'a' } }] }).ok).toBe(false)
  })

  it('rejects empty-string ids', () => {
    expect(parseWorkflowDoc({ ...minimal, id: '' }).ok).toBe(false)
    expect(
      parseWorkflowDoc({ ...minimal, nodes: [{ id: '', type: 'x', isMainOutput: true }] }).ok
    ).toBe(false)
  })
})
