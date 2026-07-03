import { describe, it, expect } from 'vitest'
import {
  ownerOfNodeId,
  nodeOwnerMap,
  readComposition,
  isSpliceEdge,
  buildPackRegions,
  projectionNodePositions,
  type CompositionLike
} from '../src/renderer/src/components/workflow/effectiveProjection'
import { PACK_PREFIX, packNodeId } from '../src/shared/workflow/compose'
import type { Edge, WorkflowDoc } from '../src/shared/workflow/types'

// Pure projection helpers for the Workflow view's Effective mode (agent-packs plan WP3.6a; ADR 0010).
// No jsdom harness exists — this is the WP3.1 pattern (agentPackDisplay.test.ts): extract the
// side-effect-free logic and unit-test it directly under Node.

describe('ownerOfNodeId (PACK_PREFIX inverse)', () => {
  it('unprefixed id → narrator', () => {
    expect(ownerOfNodeId('ctx')).toEqual({ kind: 'narrator' })
    expect(ownerOfNodeId('assemble')).toEqual({ kind: 'narrator' })
  })

  it('pack:<id>:<orig> → pack owner (dotted pack ids parse correctly)', () => {
    expect(ownerOfNodeId(packNodeId('builtin.table-memory', 'export'))).toEqual({
      kind: 'pack',
      packId: 'builtin.table-memory'
    })
    expect(ownerOfNodeId('pack:p1:blk')).toEqual({ kind: 'pack', packId: 'p1' })
  })

  it('malformed prefixed id never throws (falls back to narrator)', () => {
    expect(ownerOfNodeId(`${PACK_PREFIX}nodetail`)).toEqual({ kind: 'narrator' })
  })
})

const composition: CompositionLike = {
  packs: {
    p1: {
      nodeIds: ['pack:p1:a', 'pack:p1:b'],
      entries: [{ checkpoint: 'context-ready', mode: 'branch' }],
      rejoinEdges: [
        {
          from: { node: 'pack:p1:b', port: 'entries' },
          to: { node: 'assemble', port: 'entries' },
          checkpoint: 'prompt-assembly'
        }
      ]
    },
    p2: {
      // A trigger-only pack: present-but-detached node, no spliced attachment.
      nodeIds: ['pack:p2:n'],
      entries: [],
      rejoinEdges: []
    }
  }
}

describe('nodeOwnerMap', () => {
  it('maps every spliced node id → its packId; narrator nodes absent', () => {
    const map = nodeOwnerMap(composition)
    expect(map.get('pack:p1:a')).toBe('p1')
    expect(map.get('pack:p1:b')).toBe('p1')
    expect(map.get('pack:p2:n')).toBe('p2')
    expect(map.has('ctx')).toBe(false)
  })

  it('undefined composition → empty map', () => {
    expect(nodeOwnerMap(undefined).size).toBe(0)
  })
})

describe('readComposition', () => {
  it('reads meta.composition when present', () => {
    const doc = { meta: { composition } } as unknown as WorkflowDoc
    expect(readComposition(doc)?.packs.p1.nodeIds).toEqual(['pack:p1:a', 'pack:p1:b'])
  })
  it('undefined when no meta / no composition (the zero-packs narrator)', () => {
    expect(readComposition({} as WorkflowDoc)).toBeUndefined()
    expect(readComposition({ meta: {} } as unknown as WorkflowDoc)).toBeUndefined()
  })
})

describe('isSpliceEdge (narrator↔pack crossing)', () => {
  const owners = nodeOwnerMap(composition)
  it('a narrator→pack edge is a splice edge', () => {
    const e: Edge = { from: { node: 'ctx', port: 'gen' }, to: { node: 'pack:p1:a', port: 'gen' } }
    expect(isSpliceEdge(e, owners)).toBe(true)
  })
  it('a pack→narrator rejoin is a splice edge', () => {
    const e: Edge = {
      from: { node: 'pack:p1:b', port: 'entries' },
      to: { node: 'assemble', port: 'entries' }
    }
    expect(isSpliceEdge(e, owners)).toBe(true)
  })
  it('a narrator→narrator edge is NOT a splice edge', () => {
    const e: Edge = { from: { node: 'ctx', port: 'gen' }, to: { node: 'assemble', port: 'gen' } }
    expect(isSpliceEdge(e, owners)).toBe(false)
  })
  it('a pack-internal edge is NOT a splice edge', () => {
    const e: Edge = {
      from: { node: 'pack:p1:a', port: 'x' },
      to: { node: 'pack:p1:b', port: 'y' }
    }
    expect(isSpliceEdge(e, owners)).toBe(false)
  })
})

describe('buildPackRegions + layout', () => {
  it('a normally-spliced pack gets a node grid; a triggerOnly pack gets a detached placeholder', () => {
    const regions = buildPackRegions(composition, [
      { packId: 'p1', triggerOnly: false },
      { packId: 'p2', triggerOnly: true }
    ])
    expect(regions).toHaveLength(2)

    const p1 = regions.find((r) => r.packId === 'p1')!
    expect(p1.detached).toBe(false)
    expect(p1.nodePositions.map((n) => n.id)).toEqual(['pack:p1:a', 'pack:p1:b'])

    const p2 = regions.find((r) => r.packId === 'p2')!
    expect(p2.detached).toBe(true)
    expect(p2.nodePositions).toEqual([]) // its node floats free / is represented by the placeholder
  })

  it('stacks regions below the narrator without overlap, deterministically', () => {
    const regions = buildPackRegions(composition, [
      { packId: 'p1', triggerOnly: false },
      { packId: 'p2', triggerOnly: true }
    ])
    const [a, b] = regions
    // Both start at the same left; the second starts below the first's band (no vertical overlap).
    expect(a.bounds.x).toBe(b.bounds.x)
    expect(b.bounds.y).toBeGreaterThanOrEqual(a.bounds.y + a.bounds.height)
    // Every spliced node sits inside its region band.
    for (const np of a.nodePositions) {
      expect(np.position.y).toBeGreaterThanOrEqual(a.bounds.y)
      expect(np.position.x).toBeGreaterThanOrEqual(a.bounds.x)
    }
  })

  it('a re-fetch with the same input yields identical layout (deterministic)', () => {
    const input = [{ packId: 'p1', triggerOnly: false }]
    const first = buildPackRegions(composition, input)
    const second = buildPackRegions(composition, input)
    expect(second).toEqual(first)
  })
})

describe('projectionNodePositions', () => {
  it('flattens region node positions into one id→pos map; detached packs contribute nothing', () => {
    const regions = buildPackRegions(composition, [
      { packId: 'p1', triggerOnly: false },
      { packId: 'p2', triggerOnly: true }
    ])
    const pos = projectionNodePositions(regions)
    expect(pos.has('pack:p1:a')).toBe(true)
    expect(pos.has('pack:p1:b')).toBe(true)
    expect(pos.has('pack:p2:n')).toBe(false)
  })
})
