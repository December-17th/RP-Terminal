import { describe, it, expect } from 'vitest'
import {
  serializePackEnvelope,
  parsePackEnvelope,
  SerializePackEnvelopeInput,
  PACK_ENVELOPE_FORMAT_VERSION,
  MAX_PACK_ENVELOPE_BYTES
} from '../../src/shared/workflow/packEnvelope'
import { WorkflowDoc } from '../../src/shared/workflow/types'
import { PackManifest } from '../../src/shared/workflow/packManifest'

// The `.rptagent` v0 envelope: round-trip fidelity, byte-stable/diffable output, the version gate,
// the (untrusted) fragment revalidation, unknown-key warnings, the size cap, and bundledTemplates.

// A minimal but VALID kind:'fragment' doc (declares ≥1 attachment; structurally accepted by the
// shared gate). Two capability-mapped nodes so the fragment is non-trivial.
const fragment: WorkflowDoc = {
  id: 'frag',
  name: 'Memory Fragment',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes: [
    { id: 'read', type: 'table.read' },
    { id: 'apply', type: 'table.apply' }
  ],
  edges: [],
  attachments: [
    { kind: 'trigger', trigger: 'cadence', everyNFloors: 5 },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'read', port: 'gen' } }
  ]
}

const manifest: PackManifest = {
  name: 'Memory Keeper',
  description: 'Keeps a running memory table.',
  creator: 'someone',
  exposedSettings: [
    {
      id: 'every',
      label: { en: 'Update every', zh: '更新频率' },
      type: 'number',
      default: 5,
      min: 1,
      max: 20,
      target: { nodeId: 'apply', path: 'every' }
    }
  ]
}

const input: SerializePackEnvelopeInput = {
  id: 'pack.memory',
  version: 3,
  manifest,
  fragment
}

describe('serialize/parse round-trip', () => {
  it('serialize → parse → deep-equals the input pack', () => {
    const text = serializePackEnvelope(input)
    const r = parsePackEnvelope(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.formatVersion).toBe(PACK_ENVELOPE_FORMAT_VERSION)
    expect(r.value.kind).toBe('rptagent')
    expect(r.value.pack.id).toBe('pack.memory')
    expect(r.value.pack.version).toBe(3)
    expect(r.value.pack.name).toBe('Memory Keeper')
    expect(r.value.pack.description).toBe('Keeps a running memory table.')
    expect(r.value.pack.creator).toBe('someone')
    expect(r.value.pack.exposedSettings).toEqual(manifest.exposedSettings)
    expect(r.value.pack.fragment).toEqual(fragment)
    expect(r.warnings).toEqual([])
  })

  it('omits undefined optionals rather than writing null', () => {
    const text = serializePackEnvelope({ id: 'p', version: 1, manifest: { name: 'Bare' }, fragment })
    const obj = JSON.parse(text)
    expect(obj.pack).not.toHaveProperty('description')
    expect(obj.pack).not.toHaveProperty('creator')
    expect(obj.pack).not.toHaveProperty('exposedSettings')
    expect(obj).not.toHaveProperty('bundledTemplates')
  })
})

describe('stable / diffable output', () => {
  it('two serializations of the same input are byte-identical', () => {
    expect(serializePackEnvelope(input)).toBe(serializePackEnvelope(input))
  })

  it('key order is stable regardless of manifest key insertion order', () => {
    const reordered: PackManifest = {
      // deliberately different insertion order
      creator: manifest.creator,
      exposedSettings: manifest.exposedSettings,
      description: manifest.description,
      name: manifest.name
    }
    expect(serializePackEnvelope({ ...input, manifest: reordered })).toBe(serializePackEnvelope(input))
  })

  it('is 2-space pretty-printed', () => {
    const text = serializePackEnvelope(input)
    expect(text).toContain('\n  "kind": "rptagent"')
  })
})

describe('unsupported version gate', () => {
  it('reports unsupported-version carrying the found version', () => {
    const text = serializePackEnvelope(input).replace('"formatVersion": 1', '"formatVersion": 99')
    const r = parsePackEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('unsupported-version')
      expect(r.error.foundVersion).toBe(99)
    }
  })

  it('reports unsupported-version (not a schema error) when formatVersion is absent', () => {
    const r = parsePackEnvelope(JSON.stringify({ kind: 'rptagent', pack: {} }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unsupported-version')
  })
})

describe('untrusted fragment revalidation', () => {
  it('rejects a fragment that fails the structural gate, surfacing the underlying errors', () => {
    const bad = { ...input, fragment: { ...fragment, nodes: [{ id: '', type: 'table.read' }] } }
    const text = serializePackEnvelope(bad as SerializePackEnvelopeInput)
    const r = parsePackEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // The schema catches the empty node id before the fragment gate; either way it is rejected
      // with field errors surfaced (never silently accepted).
      expect(['invalid-envelope', 'invalid-fragment']).toContain(r.error.code)
      expect(r.error.errors && r.error.errors.length).toBeGreaterThan(0)
    }
  })

  it("rejects a graph whose kind is not 'fragment'", () => {
    const turnDoc: WorkflowDoc = { ...fragment, kind: 'turn', attachments: [] }
    const text = serializePackEnvelope({ ...input, fragment: turnDoc })
    const r = parsePackEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('not-a-fragment')
      expect(r.error.errors?.[0]).toContain('turn')
    }
  })
})

describe('unknown-key warnings (forward-compat hint, keys stripped)', () => {
  it('reports unknown top-level and pack keys as warnings, and strips them', () => {
    const obj = JSON.parse(serializePackEnvelope(input))
    obj.futureFeature = { some: 'thing' }
    obj.pack.newPackField = 42
    const r = parsePackEnvelope(JSON.stringify(obj))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toContain('unknown top-level key "futureFeature"')
    expect(r.warnings).toContain('unknown pack key "newPackField"')
    // Stripped from the parsed value (v0 does not preserve unknown keys).
    expect(r.value as unknown as Record<string, unknown>).not.toHaveProperty('futureFeature')
    expect(r.value.pack as unknown as Record<string, unknown>).not.toHaveProperty('newPackField')
  })
})

describe('size cap', () => {
  it('rejects input over the byte cap without parsing', () => {
    const huge = 'x'.repeat(MAX_PACK_ENVELOPE_BYTES + 1)
    const r = parsePackEnvelope(huge)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('too-large')
  })
})

describe('invalid JSON', () => {
  it('reports invalid-json for non-JSON text', () => {
    const r = parsePackEnvelope('not json {')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid-json')
  })
})

describe('bundledTemplates round-trip', () => {
  const template = {
    name: 'Poem Memory',
    sourceFormat: 'native' as const,
    globalInjection: { readableEntryPlacement: { position: 'at_depth_as_system', depth: 0, order: 0 } },
    tables: [
      {
        uid: 't1',
        sqlName: 'summary',
        ddl: 'CREATE TABLE summary (id INTEGER PRIMARY KEY, note TEXT)',
        displayName: '纪要表',
        note: 'the running summary',
        updateFrequency: 1
      }
    ]
  }

  it('round-trips a bundled native template (deep-equal, including passthrough fields)', () => {
    const text = serializePackEnvelope({ ...input, bundledTemplates: [template] })
    const r = parsePackEnvelope(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.bundledTemplates).toEqual([template])
  })

  it('rejects a bundled template missing the load-bearing per-table fields', () => {
    const text = serializePackEnvelope({
      ...input,
      bundledTemplates: [{ name: 'X', tables: [{ uid: 'u' } as never] }]
    })
    const r = parsePackEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid-envelope')
  })
})
