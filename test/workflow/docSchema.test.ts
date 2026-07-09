import { describe, it, expect } from 'vitest'
import { parseWorkflowDoc } from '../../src/shared/workflow/docSchema'
import { NARRATOR_SPINE_DOC as DEFAULT_GRAPH } from '../fixtures/narratorSpineDoc'

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

  it('accepts an absent kind, "turn", "subgraph", and "fragment"; rejects any other kind value', () => {
    expect(parseWorkflowDoc(minimal).ok).toBe(true)
    expect(parseWorkflowDoc({ ...minimal, kind: 'turn' }).ok).toBe(true)
    expect(parseWorkflowDoc({ ...minimal, kind: 'subgraph' }).ok).toBe(true)
    expect(parseWorkflowDoc({ ...minimal, kind: 'fragment' }).ok).toBe(true)
    expect(parseWorkflowDoc({ ...minimal, kind: 'bogus' }).ok).toBe(false)
  })

  it('round-trips a fragment doc with attachments (entry + rejoin + manual trigger)', () => {
    const frag = {
      ...minimal,
      kind: 'fragment',
      attachments: [
        { kind: 'entry', checkpoint: 'context-ready', mode: 'inline' },
        { kind: 'rejoin', checkpoint: 'prompt-assembly' },
        { kind: 'trigger', trigger: 'manual' }
      ]
    }
    const r = parseWorkflowDoc(JSON.parse(JSON.stringify(frag)))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.attachments).toHaveLength(3)
  })

  it('round-trips all three trigger shapes WITHOUT stripping condition fields (WP2.1)', () => {
    // zod objects strip undeclared keys — the trigger source/op/value/everyNFloors must survive.
    const attachments = [
      {
        kind: 'trigger',
        trigger: 'state',
        source: { scope: 'vars', path: 'stat_data.月份' },
        op: 'changedBy',
        value: 1
      },
      {
        kind: 'trigger',
        trigger: 'state',
        source: { scope: 'table', table: 'events', stat: 'unprocessed' },
        op: 'gte',
        value: 10
      },
      { kind: 'trigger', trigger: 'cadence', everyNFloors: 3 },
      { kind: 'trigger', trigger: 'manual' }
    ]
    const r = parseWorkflowDoc(
      JSON.parse(JSON.stringify({ ...minimal, kind: 'fragment', attachments }))
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.attachments).toEqual(attachments)
  })

  it('rejects structurally-broken triggers (unknown op, unknown stat, bad cadence, no discriminant)', () => {
    const base = { ...minimal, kind: 'fragment' }
    // Unknown comparison op.
    expect(
      parseWorkflowDoc({
        ...base,
        attachments: [
          { kind: 'trigger', trigger: 'state', source: { scope: 'vars', path: 'x' }, op: 'between', value: 1 }
        ]
      }).ok
    ).toBe(false)
    // Unknown table stat.
    expect(
      parseWorkflowDoc({
        ...base,
        attachments: [
          {
            kind: 'trigger',
            trigger: 'state',
            source: { scope: 'table', table: 'events', stat: 'rowCount' },
            op: 'gt',
            value: 1
          }
        ]
      }).ok
    ).toBe(false)
    // Cadence below 1.
    expect(
      parseWorkflowDoc({
        ...base,
        attachments: [{ kind: 'trigger', trigger: 'cadence', everyNFloors: 0 }]
      }).ok
    ).toBe(false)
    // Missing `trigger` discriminant (the old stub shape is no longer valid).
    expect(parseWorkflowDoc({ ...base, attachments: [{ kind: 'trigger' }] }).ok).toBe(false)
  })

  it('round-trips port designations + anchor selector WITHOUT stripping (WP1.2 ports / WP1.6b anchor)', () => {
    // zod objects STRIP undeclared keys, so these fields must be declared in the schema or a
    // fragment doc parsed through the save/import gate would silently lose its splice points.
    const attachments = [
      {
        kind: 'entry',
        checkpoint: 'context-ready',
        mode: 'inline',
        entryPort: { node: 'a', port: 'gen' },
        outPort: { node: 'a', port: 'gen' }
      },
      {
        kind: 'rejoin',
        checkpoint: 'prompt-assembly',
        anchor: 'entries',
        rejoinPort: { node: 'a', port: 'entries' }
      }
    ]
    const r = parseWorkflowDoc(
      JSON.parse(JSON.stringify({ ...minimal, kind: 'fragment', attachments }))
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.attachments).toEqual(attachments)
  })

  it('rejects a malformed port designation and an empty anchor selector', () => {
    const base = { ...minimal, kind: 'fragment' }
    expect(
      parseWorkflowDoc({
        ...base,
        attachments: [
          { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'a' } }
        ]
      }).ok
    ).toBe(false)
    expect(
      parseWorkflowDoc({
        ...base,
        attachments: [{ kind: 'rejoin', checkpoint: 'prompt-assembly', anchor: '' }]
      }).ok
    ).toBe(false)
  })

  it('round-trips on-canvas groups (WP6.3) without stripping fields', () => {
    const groups = [
      {
        id: 'group-1',
        name: 'Memory',
        nodeIds: ['n1', 'n2'],
        collapsed: true,
        exposed: [{ node: 'n1', path: 'template', label: 'Prompt' }]
      }
    ]
    const r = parseWorkflowDoc(
      JSON.parse(
        JSON.stringify({
          ...minimal,
          nodes: [
            { id: 'n1', type: 'text.template' },
            { id: 'n2', type: 'input.context', isMainOutput: true }
          ],
          groups
        })
      )
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.groups).toEqual(groups)
  })

  it('round-trips a group with `note` and `origin` (agent-memory-ux WP-A) without stripping them', () => {
    // zod objects strip undeclared keys — the agent contract's note + import provenance must survive.
    const groups = [
      {
        id: 'group-1',
        name: 'Table memory',
        nodeIds: ['n1', 'n2'],
        collapsed: true,
        note: 'Needs a bound table template + an API preset.',
        origin: 'import'
      }
    ]
    const r = parseWorkflowDoc(
      JSON.parse(
        JSON.stringify({
          ...minimal,
          nodes: [
            { id: 'n1', type: 'text.template' },
            { id: 'n2', type: 'input.context', isMainOutput: true }
          ],
          groups
        })
      )
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.groups).toEqual(groups)
  })

  it('rejects a group whose `origin` is any value other than "import" (agent-memory-ux WP-A)', () => {
    const base = {
      ...minimal,
      nodes: [
        { id: 'n1', type: 'text.template' },
        { id: 'n2', type: 'input.context', isMainOutput: true }
      ]
    }
    expect(
      parseWorkflowDoc({
        ...base,
        groups: [{ id: 'group-1', name: 'M', nodeIds: ['n1', 'n2'], origin: 'authored' }]
      }).ok
    ).toBe(false)
  })

  it('rejects a group with <2 members or empty id/name/exposed strings (WP6.3)', () => {
    const base = {
      ...minimal,
      nodes: [
        { id: 'n1', type: 'text.template' },
        { id: 'n2', type: 'input.context', isMainOutput: true }
      ]
    }
    expect(
      parseWorkflowDoc({ ...base, groups: [{ id: 'group-1', name: 'M', nodeIds: ['n1'] }] }).ok
    ).toBe(false)
    expect(
      parseWorkflowDoc({ ...base, groups: [{ id: '', name: 'M', nodeIds: ['n1', 'n2'] }] }).ok
    ).toBe(false)
    expect(
      parseWorkflowDoc({
        ...base,
        groups: [
          {
            id: 'group-1',
            name: 'M',
            nodeIds: ['n1', 'n2'],
            exposed: [{ node: 'n1', path: '', label: 'x' }]
          }
        ]
      }).ok
    ).toBe(false)
  })

  it('rejects an attachment with a bad checkpoint name or bad entry mode', () => {
    const base = { ...minimal, kind: 'fragment' }
    expect(
      parseWorkflowDoc({
        ...base,
        attachments: [{ kind: 'entry', checkpoint: 'nope', mode: 'inline' }]
      }).ok
    ).toBe(false)
    expect(
      parseWorkflowDoc({
        ...base,
        attachments: [{ kind: 'entry', checkpoint: 'context-ready', mode: 'sideways' }]
      }).ok
    ).toBe(false)
  })
})
