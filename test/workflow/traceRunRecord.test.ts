import { describe, it, expect } from 'vitest'
import { describeTrigger, derivePackIds } from '../../src/shared/workflow/trace'
import type { WorkflowRunTrace } from '../../src/shared/workflow/trace'
import type { TriggerAttachment } from '../../src/shared/workflow/attachments'
import type { CompositionMeta } from '../../src/shared/workflow/compose'
import { packNodeId } from '../../src/shared/workflow/compose'

// The pure WP2.3 annotation helpers on shared/workflow/trace.ts: describeTrigger (timeline caption)
// and derivePackIds (which packs contributed nodes — from composition meta, else a prefix scan).

// ── describeTrigger: stable, readable output for the three trigger kinds ────────────────────────────

describe('describeTrigger', () => {
  it('describes a vars-scoped state trigger (path + op + value)', () => {
    const t: TriggerAttachment = {
      kind: 'trigger',
      trigger: 'state',
      source: { scope: 'vars', path: 'stat_data.世界.时间' },
      op: 'changedBy',
      value: 30
    }
    expect(describeTrigger(t)).toBe('state: stat_data.世界.时间 changedBy 30')
  })

  it('describes a table-scoped state trigger (table.stat + op + value)', () => {
    const t: TriggerAttachment = {
      kind: 'trigger',
      trigger: 'state',
      source: { scope: 'table', table: 'log', stat: 'unprocessed' },
      op: 'gte',
      value: 10
    }
    expect(describeTrigger(t)).toBe('state: table log.unprocessed gte 10')
  })

  it('describes a cadence trigger', () => {
    const t: TriggerAttachment = { kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }
    expect(describeTrigger(t)).toBe('cadence: every 3 floors')
  })

  it('describes a manual trigger', () => {
    const t: TriggerAttachment = { kind: 'trigger', trigger: 'manual' }
    expect(describeTrigger(t)).toBe('manual')
  })

  it('renders a boolean / string comparison value verbatim', () => {
    const b: TriggerAttachment = {
      kind: 'trigger',
      trigger: 'state',
      source: { scope: 'vars', path: 'flags.done' },
      op: 'eq',
      value: true
    }
    expect(describeTrigger(b)).toBe('state: flags.done eq true')
    const s: TriggerAttachment = {
      kind: 'trigger',
      trigger: 'state',
      source: { scope: 'vars', path: 'season' },
      op: 'eq',
      value: 'winter'
    }
    expect(describeTrigger(s)).toBe('state: season eq winter')
  })
})

// ── derivePackIds: composition meta (preferred) vs prefix scan (fallback) ───────────────────────────

const traceWithNodes = (nodeIds: string[]): WorkflowRunTrace => ({
  chatId: 'c1',
  workflowId: 'wf',
  startedAt: 0,
  durationMs: 0,
  ok: true,
  aborted: false,
  nodes: nodeIds.map((nodeId) => ({
    nodeId,
    nodeType: 'text.template',
    status: 'ran' as const,
    phase: 'pre' as const
  }))
})

describe('derivePackIds', () => {
  it('a plain narrator turn (no composition, no prefixed nodes) yields []', () => {
    const trace = traceWithNodes(['ctx', 'assemble', 'llm', 'parse', 'apply', 'write'])
    expect(derivePackIds(trace)).toEqual([])
  })

  it('a prefixed-node trace (no meta) yields the packs, deduped + sorted (prefix-scan fallback)', () => {
    // Two packs each contributed a couple of nodes; the narrator spine nodes have no prefix.
    const trace = traceWithNodes([
      'ctx',
      packNodeId('memoryKeeper', 'export'),
      packNodeId('memoryKeeper', 'trim'),
      packNodeId('worldSim', 'advance'),
      'write'
    ])
    expect(derivePackIds(trace)).toEqual(['memoryKeeper', 'worldSim'])
  })

  it('prefers composition meta when BOTH are present — even a pack with zero surviving nodes counts', () => {
    // The trace only shows nodes for memoryKeeper, but the composition meta records that gatedPack
    // spliced (with zero surviving nodes after denial). The meta path reports BOTH; the prefix scan
    // alone would miss gatedPack.
    const trace = traceWithNodes([packNodeId('memoryKeeper', 'export')])
    const composition: CompositionMeta = {
      packs: {
        memoryKeeper: { nodeIds: [packNodeId('memoryKeeper', 'export')], entries: [], nodeModes: {}, rejoinEdges: [] },
        gatedPack: { nodeIds: [], entries: [], nodeModes: {}, rejoinEdges: [] }
      }
    }
    expect(derivePackIds(trace, composition)).toEqual(['gatedPack', 'memoryKeeper'])
  })

  it('composition meta with no packs yields []', () => {
    const trace = traceWithNodes(['ctx', 'write'])
    expect(derivePackIds(trace, { packs: {} })).toEqual([])
  })
})
