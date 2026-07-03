import { describe, it, expect } from 'vitest'
import {
  unprefixFragmentNodeId,
  prefixFragmentNodeId,
  applyFragmentEdit,
  fragmentEditApplies,
  ownerPackOfEdit,
  type FragmentEdit
} from '../src/renderer/src/components/workflow/packEditRouting'
import { remapEditToFragment } from '../src/renderer/src/stores/effectiveGraphStore'
import { packNodeId } from '../src/shared/workflow/compose'
import type { WorkflowDoc } from '../src/shared/workflow/types'

// Pure edit-routing logic for the Workflow view's Effective mode pack-node editing (agent-packs plan
// WP3.6b; ADR 0006 + 0010). Extracted + node-tested (the WP3.1/WP3.6a pattern): the un-prefix mapping,
// applying an edit to a COPY of the source fragment, the first-edit-vs-subsequent owner resolution, and
// the projection→fragment id remap.

const fragment = (): WorkflowDoc =>
  ({
    id: 'frag',
    name: 'F',
    version: 1,
    schemaVersion: 1,
    kind: 'fragment',
    nodes: [
      { id: 'a', type: 'text.template', config: { template: 'x' } },
      { id: 'b', type: 'text.template' }
    ],
    edges: [{ from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'in' } }],
    attachments: [{ kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'b', port: 'text' } }]
  }) as unknown as WorkflowDoc

describe('unprefix / prefix fragment node ids', () => {
  it('unprefix strips pack:<id>: for the KNOWN pack; null for a foreign/unprefixed id', () => {
    expect(unprefixFragmentNodeId(packNodeId('p1', 'blk'), 'p1')).toBe('blk')
    expect(unprefixFragmentNodeId(packNodeId('builtin.table-memory', 'export'), 'builtin.table-memory')).toBe('export')
    expect(unprefixFragmentNodeId('pack:p2:n', 'p1')).toBeNull() // other pack
    expect(unprefixFragmentNodeId('ctx', 'p1')).toBeNull() // narrator
  })
  it('prefix is the inverse', () => {
    expect(prefixFragmentNodeId('p1', 'blk')).toBe(packNodeId('p1', 'blk'))
  })
})

describe('applyFragmentEdit (pure; input untouched)', () => {
  it('config replaces the node config; empty config deletes it', () => {
    const doc = fragment()
    const next = applyFragmentEdit(doc, { kind: 'config', nodeId: 'a', config: { template: 'y' } })
    expect(next.nodes.find((n) => n.id === 'a')!.config).toEqual({ template: 'y' })
    // Original untouched.
    expect(doc.nodes.find((n) => n.id === 'a')!.config).toEqual({ template: 'x' })
    const cleared = applyFragmentEdit(doc, { kind: 'config', nodeId: 'a', config: {} })
    expect(cleared.nodes.find((n) => n.id === 'a')!.config).toBeUndefined()
  })

  it('removeNode drops the node AND its incident edges', () => {
    const next = applyFragmentEdit(fragment(), { kind: 'removeNode', nodeId: 'a' })
    expect(next.nodes.some((n) => n.id === 'a')).toBe(false)
    expect(next.edges).toHaveLength(0) // the a→b edge went with it
  })

  it('connect adds a NEW edge; a duplicate connect is a no-op', () => {
    const doc = fragment()
    const added = applyFragmentEdit(doc, {
      kind: 'connect',
      from: { node: 'b', port: 'text' },
      to: { node: 'a', port: 'in' }
    })
    expect(added.edges).toHaveLength(2)
    // Re-adding the SAME edge does not duplicate it.
    const again = applyFragmentEdit(added, {
      kind: 'connect',
      from: { node: 'b', port: 'text' },
      to: { node: 'a', port: 'in' }
    })
    expect(again.edges).toHaveLength(2)
  })

  it('removeEdge drops exactly the matched edge', () => {
    const next = applyFragmentEdit(fragment(), {
      kind: 'removeEdge',
      from: { node: 'a', port: 'text' },
      to: { node: 'b', port: 'in' }
    })
    expect(next.edges).toHaveLength(0)
  })

  it('mainOutput sets exactly one flag (clears any prior)', () => {
    const doc = fragment()
    doc.nodes[1].isMainOutput = true
    const next = applyFragmentEdit(doc, { kind: 'mainOutput', nodeId: 'a' })
    expect(next.nodes.find((n) => n.id === 'a')!.isMainOutput).toBe(true)
    expect(next.nodes.find((n) => n.id === 'b')!.isMainOutput).toBeUndefined()
  })

  it('panel undefined removes the panel', () => {
    const doc = fragment()
    doc.nodes[0].panel = { show: true }
    const next = applyFragmentEdit(doc, { kind: 'panel', nodeId: 'a', panel: undefined })
    expect(next.nodes.find((n) => n.id === 'a')!.panel).toBeUndefined()
  })
})

describe('fragmentEditApplies (stale-edit guard)', () => {
  it('true when target node(s) exist; false when a target is gone', () => {
    const doc = fragment()
    expect(fragmentEditApplies(doc, { kind: 'config', nodeId: 'a', config: {} })).toBe(true)
    expect(fragmentEditApplies(doc, { kind: 'config', nodeId: 'gone', config: {} })).toBe(false)
    expect(
      fragmentEditApplies(doc, {
        kind: 'connect',
        from: { node: 'a', port: 'text' },
        to: { node: 'gone', port: 'in' }
      })
    ).toBe(false)
  })
})

describe('ownerPackOfEdit (first-edit vs subsequent owner resolution)', () => {
  const ownerOf = (id: string): string | null =>
    id.startsWith('pack:p1:') ? 'p1' : id.startsWith('pack:p2:') ? 'p2' : null

  it('single-node edits → the node owner', () => {
    expect(ownerPackOfEdit({ kind: 'config', nodeId: 'pack:p1:a', config: {} }, ownerOf)).toBe('p1')
    expect(ownerPackOfEdit({ kind: 'removeNode', nodeId: 'ctx' }, ownerOf)).toBeNull()
  })

  it('a pack-INTERNAL edge → the pack; a splice / cross-owner edge → null (stays locked)', () => {
    const internal: FragmentEdit = {
      kind: 'connect',
      from: { node: 'pack:p1:a', port: 'x' },
      to: { node: 'pack:p1:b', port: 'y' }
    }
    expect(ownerPackOfEdit(internal, ownerOf)).toBe('p1')

    const splice: FragmentEdit = {
      kind: 'connect',
      from: { node: 'pack:p1:a', port: 'x' },
      to: { node: 'assemble', port: 'entries' }
    }
    expect(ownerPackOfEdit(splice, ownerOf)).toBeNull()

    const crossPack: FragmentEdit = {
      kind: 'connect',
      from: { node: 'pack:p1:a', port: 'x' },
      to: { node: 'pack:p2:n', port: 'y' }
    }
    expect(ownerPackOfEdit(crossPack, ownerOf)).toBeNull()
  })
})

describe('remapEditToFragment (projection → fragment ids)', () => {
  const mapNode = (id: string): string | null => unprefixFragmentNodeId(id, 'p1')

  it('remaps a single-node edit to the un-prefixed fragment id', () => {
    const out = remapEditToFragment({ kind: 'config', nodeId: 'pack:p1:blk', config: { a: 1 } }, mapNode)
    expect(out).toEqual({ kind: 'config', nodeId: 'blk', config: { a: 1 } })
  })

  it('remaps an internal edge; returns null if any end is not this pack (splice/foreign)', () => {
    const internal = remapEditToFragment(
      {
        kind: 'connect',
        from: { node: 'pack:p1:a', port: 'x' },
        to: { node: 'pack:p1:b', port: 'y' }
      },
      mapNode
    )
    expect(internal).toEqual({
      kind: 'connect',
      from: { node: 'a', port: 'x' },
      to: { node: 'b', port: 'y' }
    })

    const foreign = remapEditToFragment(
      {
        kind: 'connect',
        from: { node: 'pack:p1:a', port: 'x' },
        to: { node: 'assemble', port: 'entries' }
      },
      mapNode
    )
    expect(foreign).toBeNull()
  })

  it('returns null for an edit whose node is not this pack', () => {
    expect(remapEditToFragment({ kind: 'removeNode', nodeId: 'pack:p2:n' }, mapNode)).toBeNull()
  })
})
