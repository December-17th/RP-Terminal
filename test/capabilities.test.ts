import { describe, it, expect } from 'vitest'
import {
  deriveCapabilities,
  capabilityOfNodeType,
  structuralCapabilities,
  isWriteCapability,
  CAPABILITY_IDS,
  WRITE_CAPABILITIES
} from '../src/shared/workflow/capabilities'
import { WorkflowDoc } from '../src/shared/workflow/types'
import { AttachmentDecl } from '../src/shared/workflow/attachments'

// Pins the display-grade capability derivation (ADR 0007's mechanical table): node types + edge/
// attachment-derived capabilities, pure. This is the same table phase 4 will HARDEN for enforcement.

const doc = (
  nodeTypes: string[],
  attachments: AttachmentDecl[] = []
): WorkflowDoc => ({
  id: 'f',
  name: 'f',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes: nodeTypes.map((type, i) => ({ id: `n${i}`, type })),
  edges: [],
  attachments
})

describe('capabilityOfNodeType', () => {
  it('maps each node type to its ADR-0007 capability', () => {
    expect(capabilityOfNodeType('table.read')).toBe('reads-tables')
    expect(capabilityOfNodeType('table.query')).toBe('reads-tables')
    expect(capabilityOfNodeType('table.export')).toBe('reads-tables')
    expect(capabilityOfNodeType('table.apply')).toBe('writes-tables')
    expect(capabilityOfNodeType('vars.get')).toBe('reads-vars')
    expect(capabilityOfNodeType('vars.save')).toBe('writes-vars')
    expect(capabilityOfNodeType('mvu.set')).toBe('writes-vars')
    expect(capabilityOfNodeType('apply.state')).toBe('writes-vars')
    expect(capabilityOfNodeType('lorebook.select')).toBe('reads-lorebooks')
    expect(capabilityOfNodeType('lorebook.entries')).toBe('reads-lorebooks')
    expect(capabilityOfNodeType('tool.lorebookSearch')).toBe('reads-lorebooks')
    expect(capabilityOfNodeType('context.history')).toBe('reads-history')
    expect(capabilityOfNodeType('input.context')).toBe('reads-history')
    expect(capabilityOfNodeType('llm.sample')).toBe('calls-llm')
    expect(capabilityOfNodeType('output.writeFloor')).toBe('writes-floors')
    expect(capabilityOfNodeType('tool.startCombat')).toBe('runs-game-tools')
    expect(capabilityOfNodeType('tool.startDuel')).toBe('runs-game-tools')
  })

  it('returns undefined for capability-neutral / unknown types (ignored, never a broad grant)', () => {
    expect(capabilityOfNodeType('util.log')).toBeUndefined()
    expect(capabilityOfNodeType('prompt.messages')).toBeUndefined()
    expect(capabilityOfNodeType('context.refresh')).toBeUndefined()
    expect(capabilityOfNodeType('context.trimProcessed')).toBeUndefined()
    expect(capabilityOfNodeType('made.up.node')).toBeUndefined()
  })
})

describe('structuralCapabilities (edge/attachment-derived, NOT node-type)', () => {
  it('injects-prompt from a prompt-assembly rejoin', () => {
    expect(
      structuralCapabilities([
        { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'x', port: 'y' } }
      ])
    ).toEqual(['injects-prompt'])
  })

  it('does NOT derive injects-prompt from a rejoin at a different checkpoint', () => {
    expect(
      structuralCapabilities([
        { kind: 'rejoin', checkpoint: 'turn-committed', rejoinPort: { node: 'x', port: 'y' } }
      ])
    ).toEqual([])
  })

  it('runs-headless from any trigger', () => {
    expect(structuralCapabilities([{ kind: 'trigger', trigger: 'manual' }])).toEqual([
      'runs-headless'
    ])
    expect(
      structuralCapabilities([{ kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }])
    ).toEqual(['runs-headless'])
  })

  it('an entry attachment derives no capability', () => {
    expect(
      structuralCapabilities([{ kind: 'entry', checkpoint: 'context-ready', mode: 'branch' }])
    ).toEqual([])
  })
})

describe('deriveCapabilities', () => {
  it('returns [] for a fragment with no capability-conferring nodes or structure', () => {
    expect(deriveCapabilities(doc(['util.log', 'prompt.messages']))).toEqual([])
  })

  it('dedupes and returns in CAPABILITY_IDS order regardless of node order', () => {
    const caps = deriveCapabilities(
      doc(['table.apply', 'table.read', 'table.export', 'llm.sample'])
    )
    // reads-tables (from read/export) before writes-tables? No — CAPABILITY_IDS order:
    // reads-tables, writes-tables, ..., calls-llm.
    expect(caps).toEqual(['reads-tables', 'writes-tables', 'calls-llm'])
  })

  it('mirrors the flagship async-memory pack surface', () => {
    // Node types + attachments taken from asyncMemoryPack.ts: table.export/read (reads-tables),
    // table.apply (writes-tables), input.context/context.history (reads-history), llm.sample
    // (calls-llm); a prompt-assembly rejoin (injects-prompt) + a trigger (runs-headless).
    const caps = deriveCapabilities(
      doc(
        [
          'context.trimProcessed',
          'table.export',
          'input.context',
          'table.gate',
          'table.read',
          'context.refresh',
          'context.history',
          'context.params',
          'prompt.messages',
          'llm.sample',
          'parse.extract',
          'table.apply',
          'util.log'
        ],
        [
          { kind: 'entry', checkpoint: 'context-ready', mode: 'inline', entryPort: { node: 'trim', port: 'gen' }, outPort: { node: 'trim', port: 'gen' } },
          { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'export', port: 'gen' } },
          { kind: 'rejoin', checkpoint: 'prompt-assembly', anchor: 'entries', rejoinPort: { node: 'export', port: 'entries' } },
          { kind: 'trigger', trigger: 'state', source: { scope: 'table', table: 'summary', stat: 'unprocessed' }, op: 'gte', value: 6 }
        ]
      )
    )
    expect(caps).toEqual([
      'reads-tables',
      'writes-tables',
      'reads-history',
      'calls-llm',
      'injects-prompt',
      'runs-headless'
    ])
  })
})

describe('write capability split', () => {
  it('only writes-* are write capabilities', () => {
    expect([...WRITE_CAPABILITIES].sort()).toEqual(
      ['writes-floors', 'writes-tables', 'writes-vars'].sort()
    )
    for (const id of CAPABILITY_IDS) {
      expect(isWriteCapability(id)).toBe(id.startsWith('writes-'))
    }
  })
})
