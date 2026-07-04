import { describe, it, expect } from 'vitest'
import {
  serializeRecipeEnvelope,
  parseRecipeEnvelope,
  SerializeRecipeEnvelopeInput,
  RECIPE_ENVELOPE_FORMAT_VERSION,
  MAX_RECIPE_ENVELOPE_BYTES
} from '../../src/shared/workflow/recipeEnvelope'
import { serializePackEnvelope } from '../../src/shared/workflow/packEnvelope'
import type { PackPayload } from '../../src/shared/workflow/packPayload'
import { WorkflowDoc } from '../../src/shared/workflow/types'

// The `.rptrecipe` v1 envelope (ADR 0008): round-trip fidelity, byte-stable output, the version gate,
// untrusted revalidation of every embedded pack fragment + the embedded narrator, the internal-
// reference / uniqueness invariants, unknown-key warnings at every level, the (fat) size cap, and the
// shared bundledTemplates pool.

// A minimal but VALID kind:'fragment' doc (declares ≥1 attachment; accepted by the shared gate).
const makeFragment = (id: string): WorkflowDoc => ({
  id,
  name: `Fragment ${id}`,
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes: [
    { id: 'read', type: 'table.read' },
    { id: 'apply', type: 'table.apply' }
  ],
  edges: [],
  attachments: [{ kind: 'trigger', trigger: 'cadence', everyNFloors: 5 }]
})

const packA: PackPayload = {
  id: 'pack.memory',
  version: 3,
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
  ],
  fragment: makeFragment('frag.memory')
}

const packB: PackPayload = {
  id: 'pack.mood',
  version: 1,
  name: 'Mood Tracker',
  fragment: makeFragment('frag.mood')
}

// A minimal VALID turn doc for an embedded custom narrator: exactly one main-output node, kind 'turn'.
const narratorDoc: WorkflowDoc = {
  id: 'custom-narrator',
  name: 'Custom Narrator',
  version: 1,
  schemaVersion: 1,
  kind: 'turn',
  nodes: [{ id: 'out', type: 'output.writeFloor', isMainOutput: true }],
  edges: []
}

const baseInput: SerializeRecipeEnvelopeInput = {
  id: 'recipe.starter',
  name: 'Starter World',
  description: 'A cozy starting setup.',
  creator: 'author',
  narrator: { kind: 'builtin' },
  packs: [packA, packB],
  activation: [
    { packId: 'pack.memory', version: 3, enabled: true, overrides: { every: 8 } },
    { packId: 'pack.mood', version: 1, enabled: false }
  ]
}

describe('serialize/parse round-trip', () => {
  it('serialize → parse → deep-equals the input recipe', () => {
    const text = serializeRecipeEnvelope(baseInput)
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.formatVersion).toBe(RECIPE_ENVELOPE_FORMAT_VERSION)
    expect(r.value.kind).toBe('rptrecipe')
    expect(r.value.recipe.id).toBe('recipe.starter')
    expect(r.value.recipe.name).toBe('Starter World')
    expect(r.value.recipe.description).toBe('A cozy starting setup.')
    expect(r.value.recipe.creator).toBe('author')
    expect(r.value.recipe.narrator).toEqual({ kind: 'builtin' })
    expect(r.value.recipe.packs).toEqual([packA, packB])
    expect(r.value.recipe.activation).toEqual(baseInput.activation)
    expect(r.warnings).toEqual([])
  })

  it('omits undefined optionals rather than writing null', () => {
    const text = serializeRecipeEnvelope({
      id: 'r',
      name: 'Bare',
      narrator: { kind: 'builtin' },
      packs: [packB],
      activation: [{ packId: 'pack.mood', version: 1, enabled: true }]
    })
    const obj = JSON.parse(text)
    expect(obj.recipe).not.toHaveProperty('description')
    expect(obj.recipe).not.toHaveProperty('creator')
    expect(obj).not.toHaveProperty('bundledTemplates')
    expect(obj.recipe.activation[0]).not.toHaveProperty('overrides')
  })

  it('an embedded pack serializes byte-identically to a standalone .rptagent pack', () => {
    // The recipe reuses packPayload.PACK_ORDER + orderedPack; an embedded pack's JSON block must match
    // what serializePackEnvelope emits for the same pack (a recipe-exported pack diffs cleanly).
    const recipeText = serializeRecipeEnvelope({ ...baseInput, packs: [packA], activation: [] })
    const standalone = serializePackEnvelope({
      id: packA.id,
      version: packA.version,
      manifest: {
        name: packA.name,
        description: packA.description,
        creator: packA.creator,
        exposedSettings: packA.exposedSettings
      },
      fragment: packA.fragment
    })
    // Extract each "pack" object body textually is brittle; instead re-parse both and compare the pack.
    const rr = parseRecipeEnvelope(recipeText)
    const sr = JSON.parse(standalone)
    expect(rr.ok).toBe(true)
    if (!rr.ok) return
    expect(rr.value.recipe.packs[0]).toEqual(sr.pack)
  })
})

describe('stable / diffable output', () => {
  it('two serializations of the same input are byte-identical', () => {
    expect(serializeRecipeEnvelope(baseInput)).toBe(serializeRecipeEnvelope(baseInput))
  })

  it('key order is stable regardless of input key insertion order', () => {
    const reordered: SerializeRecipeEnvelopeInput = {
      activation: baseInput.activation,
      packs: baseInput.packs,
      narrator: baseInput.narrator,
      creator: baseInput.creator,
      description: baseInput.description,
      name: baseInput.name,
      id: baseInput.id
    }
    expect(serializeRecipeEnvelope(reordered)).toBe(serializeRecipeEnvelope(baseInput))
  })

  it('is 2-space pretty-printed', () => {
    expect(serializeRecipeEnvelope(baseInput)).toContain('\n  "kind": "rptrecipe"')
  })
})

describe('narrator', () => {
  it('builtin narrator round-trips carrying no doc and no id', () => {
    const text = serializeRecipeEnvelope(baseInput)
    const obj = JSON.parse(text)
    expect(obj.recipe.narrator).toEqual({ kind: 'builtin' })
    expect(obj.recipe.narrator).not.toHaveProperty('doc')
    expect(obj.recipe.narrator).not.toHaveProperty('id')
  })

  it('embedded custom narrator round-trips its full turn doc', () => {
    const input = { ...baseInput, narrator: { kind: 'embedded' as const, doc: narratorDoc } }
    const r = parseRecipeEnvelope(serializeRecipeEnvelope(input))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.recipe.narrator).toEqual({ kind: 'embedded', doc: narratorDoc })
  })

  it('rejects an embedded narrator with no main-output node', () => {
    const bad = { ...narratorDoc, nodes: [{ id: 'out', type: 'output.writeFloor' }] }
    const input = { ...baseInput, narrator: { kind: 'embedded' as const, doc: bad } }
    const r = parseRecipeEnvelope(serializeRecipeEnvelope(input))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-narrator')
      expect(r.error.errors?.[0]).toContain('main-output')
    }
  })

  it('rejects an embedded narrator with two main-output nodes', () => {
    const bad = {
      ...narratorDoc,
      nodes: [
        { id: 'a', type: 'output.writeFloor', isMainOutput: true },
        { id: 'b', type: 'output.writeFloor', isMainOutput: true }
      ]
    }
    const input = { ...baseInput, narrator: { kind: 'embedded' as const, doc: bad } }
    const r = parseRecipeEnvelope(serializeRecipeEnvelope(input))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid-narrator')
  })

  it("rejects an embedded narrator whose kind is not 'turn'", () => {
    const bad = { ...narratorDoc, kind: 'fragment' as const, attachments: [{ kind: 'trigger', trigger: 'manual' }] }
    const input = { ...baseInput, narrator: { kind: 'embedded' as const, doc: bad as WorkflowDoc } }
    const r = parseRecipeEnvelope(serializeRecipeEnvelope(input))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-narrator')
      expect(r.error.errors?.[0]).toContain('turn')
    }
  })
})

describe('overrides map', () => {
  it('round-trips a scope-free settingId → value override map', () => {
    const input: SerializeRecipeEnvelopeInput = {
      ...baseInput,
      activation: [
        {
          packId: 'pack.memory',
          version: 3,
          enabled: true,
          overrides: { every: 12, mood: 'calm', flag: true, nested: { a: 1 } }
        },
        { packId: 'pack.mood', version: 1, enabled: true }
      ]
    }
    const r = parseRecipeEnvelope(serializeRecipeEnvelope(input))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.recipe.activation[0].overrides).toEqual({
      every: 12,
      mood: 'calm',
      flag: true,
      nested: { a: 1 }
    })
  })
})

describe('unsupported version gate', () => {
  it('reports unsupported-version carrying the found version', () => {
    const text = serializeRecipeEnvelope(baseInput).replace('"formatVersion": 1', '"formatVersion": 99')
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('unsupported-version')
      expect(r.error.foundVersion).toBe(99)
    }
  })

  it('reports unsupported-version (not schema error) when formatVersion is absent', () => {
    const r = parseRecipeEnvelope(JSON.stringify({ kind: 'rptrecipe', recipe: {} }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unsupported-version')
  })
})

describe('untrusted embedded fragment revalidation', () => {
  it('rejects an embedded pack whose fragment fails the structural gate', () => {
    const badPack = { ...packA, fragment: { ...packA.fragment, nodes: [{ id: '', type: 'table.read' }] } }
    const text = serializeRecipeEnvelope({
      ...baseInput,
      packs: [badPack as PackPayload, packB]
    })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['invalid-envelope', 'invalid-fragment']).toContain(r.error.code)
  })

  it("rejects an embedded pack whose graph kind is not 'fragment'", () => {
    const turnPack = {
      ...packB,
      fragment: { ...packB.fragment, kind: 'turn' as const, attachments: [] }
    }
    const text = serializeRecipeEnvelope({
      ...baseInput,
      packs: [packA, turnPack as PackPayload],
      activation: baseInput.activation
    })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('not-a-fragment')
      // The pack index is carried so import UI can name the bad pack.
      expect(r.error.errors?.[0]).toContain('packs[1]')
    }
  })
})

describe('internal-reference + uniqueness invariants (ADR 0008)', () => {
  it('rejects duplicate (id, version) within packs[]', () => {
    const text = serializeRecipeEnvelope({
      ...baseInput,
      packs: [packA, packA],
      activation: [{ packId: 'pack.memory', version: 3, enabled: true }]
    })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('duplicate-pack')
  })

  it('accepts two DIFFERENT versions of the same pack id (coexistence)', () => {
    const packAv4 = { ...packA, version: 4, fragment: makeFragment('frag.memory.v4') }
    const text = serializeRecipeEnvelope({
      ...baseInput,
      packs: [packA, packAv4],
      // activation picks exactly ONE version of the id
      activation: [{ packId: 'pack.memory', version: 4, enabled: true }]
    })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.recipe.packs).toHaveLength(2)
  })

  it('rejects an activation entry referring to a (packId, version) not in packs[]', () => {
    const text = serializeRecipeEnvelope({
      ...baseInput,
      packs: [packA, packB],
      activation: [
        { packId: 'pack.memory', version: 3, enabled: true },
        { packId: 'pack.ghost', version: 9, enabled: true }
      ]
    })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('activation-refers-unknown-pack')
  })

  it('rejects an activation entry referring to a WRONG version of a present id', () => {
    const text = serializeRecipeEnvelope({
      ...baseInput,
      packs: [packA],
      activation: [{ packId: 'pack.memory', version: 99, enabled: true }]
    })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('activation-refers-unknown-pack')
  })

  it('rejects two activation entries naming the same packId (one version per pack)', () => {
    const packAv4 = { ...packA, version: 4, fragment: makeFragment('frag.memory.v4') }
    const text = serializeRecipeEnvelope({
      ...baseInput,
      packs: [packA, packAv4],
      activation: [
        { packId: 'pack.memory', version: 3, enabled: true },
        { packId: 'pack.memory', version: 4, enabled: false }
      ]
    })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('activation-duplicate-pack')
  })
})

describe('unknown-key warnings (forward-compat hint, keys stripped)', () => {
  it('reports unknown keys at top / recipe / pack / activation levels, and strips them', () => {
    const obj = JSON.parse(serializeRecipeEnvelope(baseInput))
    obj.futureFeature = { some: 'thing' }
    obj.recipe.newRecipeField = 42
    obj.recipe.packs[0].newPackField = 1
    obj.recipe.activation[0].newActField = 2
    const r = parseRecipeEnvelope(JSON.stringify(obj))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toContain('unknown top-level key "futureFeature"')
    expect(r.warnings).toContain('unknown recipe key "newRecipeField"')
    expect(r.warnings).toContain('unknown packs[0] key "newPackField"')
    expect(r.warnings).toContain('unknown activation[0] key "newActField"')
    expect(r.value as unknown as Record<string, unknown>).not.toHaveProperty('futureFeature')
    expect(r.value.recipe as unknown as Record<string, unknown>).not.toHaveProperty('newRecipeField')
    expect(r.value.recipe.packs[0] as unknown as Record<string, unknown>).not.toHaveProperty('newPackField')
    expect(r.value.recipe.activation[0] as unknown as Record<string, unknown>).not.toHaveProperty('newActField')
  })
})

describe('size cap', () => {
  it('rejects input over the (fat) byte cap without parsing', () => {
    const huge = 'x'.repeat(MAX_RECIPE_ENVELOPE_BYTES + 1)
    const r = parseRecipeEnvelope(huge)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('too-large')
  })

  it('the recipe cap is larger than the per-pack cap (recipes are fat by design)', () => {
    // 64 MiB > 8 MiB — a recipe embeds many packs.
    expect(MAX_RECIPE_ENVELOPE_BYTES).toBeGreaterThan(8 * 1024 * 1024)
  })
})

describe('invalid JSON', () => {
  it('reports invalid-json for non-JSON text', () => {
    const r = parseRecipeEnvelope('not json {')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid-json')
  })
})

describe('bundledTemplates shared pool round-trip', () => {
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
        updateFrequency: 1
      }
    ]
  }

  it('round-trips the shared bundledTemplates pool (deep-equal, including passthrough fields)', () => {
    const text = serializeRecipeEnvelope({ ...baseInput, bundledTemplates: [template] })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.bundledTemplates).toEqual([template])
  })

  it('rejects a bundled template missing the load-bearing per-table fields', () => {
    const text = serializeRecipeEnvelope({
      ...baseInput,
      bundledTemplates: [{ name: 'X', tables: [{ uid: 'u' } as never] }]
    })
    const r = parseRecipeEnvelope(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid-envelope')
  })
})
