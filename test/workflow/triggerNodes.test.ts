import { describe, it, expect } from 'vitest'
import { parseWorkflowDoc } from '../../src/shared/workflow/docSchema'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import {
  isTriggerNodeType,
  triggerAttachmentOf,
  triggerState,
  triggerCadence,
  triggerManual
} from '../../src/main/services/nodes/builtin/triggerNodes'
import { describeTrigger } from '../../src/shared/workflow/trace'
import { NodeInstance } from '../../src/shared/workflow/types'

// One-canvas rebuild (WP6.1; ADR 0011): the trigger.* node types + the `disabled` flag round-trip.

describe('trigger node descriptors', () => {
  it('all three are registered, graph roots with a single Signal output, marked isTrigger', () => {
    for (const impl of [triggerState, triggerCadence, triggerManual]) {
      expect(builtinRegistry.has(impl.type)).toBe(true)
      expect(impl.inputs).toEqual([])
      expect(impl.outputs).toEqual([{ name: 'fired', type: 'Signal' }])
      expect(impl.isTrigger).toBe(true)
    }
  })

  it('isTriggerNodeType recognizes the three kinds and nothing else', () => {
    expect(isTriggerNodeType('trigger.state')).toBe(true)
    expect(isTriggerNodeType('trigger.cadence')).toBe(true)
    expect(isTriggerNodeType('trigger.manual')).toBe(true)
    expect(isTriggerNodeType('input.context')).toBe(false)
  })
})

describe('triggerAttachmentOf (reuse of the WP2.1 grammar)', () => {
  it('reconstitutes a state trigger attachment matching describeTrigger', () => {
    const node: NodeInstance = {
      id: 't',
      type: 'trigger.state',
      config: { source: { scope: 'vars', path: 'stat_data.hp' }, op: 'gt', value: 10 }
    }
    const att = triggerAttachmentOf(node)
    expect(att).toEqual({
      kind: 'trigger',
      trigger: 'state',
      source: { scope: 'vars', path: 'stat_data.hp' },
      op: 'gt',
      value: 10
    })
    expect(describeTrigger(att!)).toBe('state: stat_data.hp gt 10')
  })

  it('reconstitutes cadence + manual', () => {
    expect(triggerAttachmentOf({ id: 'c', type: 'trigger.cadence', config: { everyNFloors: 3 } })).toEqual({
      kind: 'trigger',
      trigger: 'cadence',
      everyNFloors: 3
    })
    expect(triggerAttachmentOf({ id: 'm', type: 'trigger.manual' })).toEqual({
      kind: 'trigger',
      trigger: 'manual'
    })
  })

  it('returns null for a malformed config or a non-trigger node', () => {
    expect(triggerAttachmentOf({ id: 'x', type: 'trigger.cadence', config: { everyNFloors: 0 } })).toBeNull()
    expect(triggerAttachmentOf({ id: 'y', type: 'input.context' })).toBeNull()
  })
})

describe('trigger nodes in a turn doc', () => {
  it('a doc with a trigger-rooted chain passes validation', () => {
    const doc = {
      id: 'w',
      name: 'w',
      version: 1,
      schemaVersion: 1,
      nodes: [
        { id: 'main', type: 'input.context', isMainOutput: true },
        { id: 'trg', type: 'trigger.cadence', config: { everyNFloors: 2 } },
        { id: 'tpl', type: 'text.template', config: { template: 'x' } }
      ],
      edges: [{ from: { node: 'trg', port: 'fired' }, to: { node: 'tpl', port: 'when' } }]
    }
    const v = validateWorkflow(doc, builtinRegistry.descriptors())
    expect(v.ok).toBe(true)
  })
})

describe('disabled flag round-trip (docSchema)', () => {
  it('preserves node.disabled through parse', () => {
    const r = parseWorkflowDoc({
      id: 'w',
      name: 'w',
      version: 1,
      schemaVersion: 1,
      nodes: [{ id: 'n1', type: 'input.context', isMainOutput: true, disabled: true }],
      edges: []
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.nodes[0].disabled).toBe(true)
  })
})
