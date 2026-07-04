import { describe, it, expect } from 'vitest'
import {
  NODE_W,
  NODE_H,
  MODULE_PORT,
  nextGroupId,
  groupBounds,
  collapsedView
} from '../../src/renderer/src/components/workflow/groupModel'
import type {
  EditorNode,
  EditorEdge
} from '../../src/renderer/src/components/workflow/editorModel'
import type { GroupDecl } from '../../src/shared/workflow/types'

const n = (id: string, x: number, y: number): EditorNode => ({ id, type: 't', position: { x, y } })
const e = (
  source: string,
  target: string,
  sourcePort = 'out',
  targetPort = 'in'
): EditorEdge => ({ id: `${source}:${sourcePort}->${target}:${targetPort}`, source, sourcePort, target, targetPort })

describe('nextGroupId', () => {
  it('mints group-<n> at the first free suffix', () => {
    expect(nextGroupId([])).toBe('group-1')
    expect(nextGroupId([{ id: 'group-1', name: 'x', nodeIds: ['a', 'b'] }])).toBe('group-2')
    expect(
      nextGroupId([
        { id: 'group-1', name: 'x', nodeIds: ['a', 'b'] },
        { id: 'group-3', name: 'y', nodeIds: ['c', 'd'] }
      ])
    ).toBe('group-2')
  })
})

describe('groupBounds', () => {
  it('encloses members by top-left + extent, padded', () => {
    const nodes = [n('a', 100, 100), n('b', 300, 250)]
    const b = groupBounds(nodes, new Set(['a', 'b']), 10)
    expect(b.x).toBe(90)
    expect(b.y).toBe(90)
    expect(b.w).toBe(300 + NODE_W - 100 + 20)
    expect(b.h).toBe(250 + NODE_H - 100 + 20)
  })

  it('skips non-members and returns a zero box for an empty set', () => {
    const nodes = [n('a', 0, 0)]
    expect(groupBounds(nodes, new Set(['ghost']))).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('collapsedView', () => {
  const groups: GroupDecl[] = [{ id: 'g1', name: 'M', nodeIds: ['b', 'c'], collapsed: true }]
  // a -> b -> c -> d, plus b -> c internal to the group.
  const nodes = [n('a', 0, 0), n('b', 100, 0), n('c', 200, 0), n('d', 300, 0)]
  const edges = [e('a', 'b'), e('b', 'c'), e('c', 'd')]

  it('filters out members of a collapsed group from visibleNodes; expanded groups keep members', () => {
    const view = collapsedView(nodes, edges, groups)
    expect(view.visibleNodes.map((x) => x.id).sort()).toEqual(['a', 'd'])

    const expanded = collapsedView(nodes, edges, [{ ...groups[0], collapsed: false }])
    expect(expanded.visibleNodes.map((x) => x.id).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(expanded.moduleNodes).toHaveLength(0)
    expect(expanded.syntheticEdges).toHaveLength(0)
  })

  it('emits one module node at the bounds top-left with the member count', () => {
    const view = collapsedView(nodes, edges, groups)
    expect(view.moduleNodes).toHaveLength(1)
    expect(view.moduleNodes[0].group.id).toBe('g1')
    expect(view.moduleNodes[0].memberCount).toBe(2)
    const b = groupBounds(nodes, new Set(['b', 'c']))
    expect(view.moduleNodes[0].position).toEqual({ x: b.x, y: b.y })
  })

  it('re-points boundary-crossing edges to the module id via the generic handle; drops internal edges', () => {
    const view = collapsedView(nodes, edges, groups)
    // a->b (target in group) and c->d (source in group) become synthetic; b->c (internal) dropped.
    expect(view.syntheticEdges).toHaveLength(2)
    const intoModule = view.syntheticEdges.find((s) => s.target === 'g1')!
    expect(intoModule.source).toBe('a')
    expect(intoModule.targetPort).toBe(MODULE_PORT)
    expect(intoModule.id).toBe('grp:' + e('a', 'b').id)
    const outOfModule = view.syntheticEdges.find((s) => s.source === 'g1')!
    expect(outOfModule.target).toBe('d')
    expect(outOfModule.sourcePort).toBe(MODULE_PORT)
    // No internal (b->c) synthetic edge survives.
    expect(view.syntheticEdges.some((s) => s.source === 'g1' && s.target === 'g1')).toBe(false)
  })

  it('collapses duplicate synthetic ids to one edge', () => {
    // Two parallel a->b edges (same edge id shape) map to the SAME synthetic id → one edge.
    const dupEdges = [e('a', 'b'), e('a', 'b'), e('c', 'd')]
    const view = collapsedView(nodes, dupEdges, groups)
    const intoModule = view.syntheticEdges.filter((s) => s.target === 'g1')
    expect(intoModule).toHaveLength(1)
  })

  it('maps an edge between two collapsed groups to a module→module synthetic edge', () => {
    const twoGroups: GroupDecl[] = [
      { id: 'g1', name: 'M1', nodeIds: ['a', 'b'], collapsed: true },
      { id: 'g2', name: 'M2', nodeIds: ['c', 'd'], collapsed: true }
    ]
    const view = collapsedView(nodes, [e('b', 'c')], twoGroups)
    expect(view.syntheticEdges).toHaveLength(1)
    expect(view.syntheticEdges[0].source).toBe('g1')
    expect(view.syntheticEdges[0].target).toBe('g2')
  })
})
