import { describe, it, expect } from 'vitest'
import {
  rowToPack,
  packToSummary,
  resolveGate,
  pickPinnedRecord,
  layerOverrides,
  layerOverridesWithProvenance,
  encodeScope,
  ActivationRow,
  OverrideRow,
  AgentPackRecord
} from '../src/main/services/agentPackStore'
import { WorkflowDoc } from '../src/shared/workflow/types'

// The native better-sqlite3 binary can't load under plain Node (test/mocks/better-sqlite3.ts is a
// no-op stub), so the SQL wrappers are runtime-validated only — mirroring tableOps/tableDb/nodeState.
// Here we pin the PURE resolution logic the store exports: row parsing, gate resolution, override
// layering, and scope encoding.

const fragment: WorkflowDoc = {
  id: 'frag',
  name: 'F',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes: [{ id: 'blk', type: 'text.template' }],
  edges: [],
  attachments: [{ kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }]
}

describe('rowToPack / packToSummary', () => {
  const row = {
    id: 'p1',
    version: 2,
    upstream_id: 'p0',
    upstream_version: 1,
    builtin: 1,
    manifest: JSON.stringify({ name: 'Memory Keeper', creator: 'me' }),
    fragment: JSON.stringify(fragment)
  }

  it('parses blobs and coerces the builtin flag + upstream lineage (id + version)', () => {
    const pack = rowToPack(row)
    expect(pack).toMatchObject({ id: 'p1', version: 2, upstreamId: 'p0', upstreamVersion: 1, builtin: true })
    expect(pack.manifest.name).toBe('Memory Keeper')
    expect(pack.fragment.kind).toBe('fragment')
  })

  it('null upstream_id/version → null lineage; builtin 0 → false', () => {
    const pack = rowToPack({ ...row, upstream_id: null, upstream_version: null, builtin: 0 })
    expect(pack.upstreamId).toBeNull()
    expect(pack.upstreamVersion).toBeNull()
    expect(pack.builtin).toBe(false)
  })

  it('summary drops the fragment blob but keeps manifest + lineage + builtin, and derives the WP3.1 display extras', () => {
    // WP3.1 EXTENDED packToSummary's payload (deliberate behavior change, updated here in the same
    // change per CLAUDE.md): the summary now also carries the fragment's `attachments` (the card's
    // badge structure) + derived `capabilities` (its chips) — both read-only-derived from the
    // fragment, which itself is STILL dropped. The test fragment has a prompt-assembly rejoin
    // (→ injects-prompt) and a capability-neutral text.template node.
    const s = packToSummary(rowToPack(row))
    expect(s).toEqual({
      id: 'p1',
      version: 2,
      upstreamId: 'p0',
      upstreamVersion: 1,
      builtin: true,
      manifest: { name: 'Memory Keeper', creator: 'me' },
      attachments: [
        { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }
      ],
      capabilities: ['injects-prompt'],
      // WP4.6: packToSummary defaults the grouped lineage to this record's own version (the service
      // overrides it with the id's full installed-version set — it sees the whole library list).
      versions: [2]
    })
    // The fragment blob itself is still NOT in the summary (only its derived display extras are).
    expect('fragment' in s).toBe(false)
  })
})

describe('resolveGate (Activation)', () => {
  const worldRow = (open: boolean, pinVersion: number | null = null): ActivationRow => ({
    packId: 'p',
    worldId: 'w',
    chatId: null,
    gateOpen: open,
    denial: [],
    pinVersion
  })
  const chatRow = (open: boolean, denial: number[] = [], pinVersion: number | null = null): ActivationRow => ({
    packId: 'p',
    worldId: 'w',
    chatId: 'c',
    gateOpen: open,
    denial,
    pinVersion
  })

  it('no rows → CLOSED (packs are opt-in), pinVersion null', () => {
    expect(resolveGate([], 'w', 'c')).toEqual({ open: false, denial: [], pinVersion: null })
  })

  it('world row open → open when no chat exception', () => {
    expect(resolveGate([worldRow(true)], 'w', 'c').open).toBe(true)
  })

  it('chat row CLOSED overrides world row OPEN (chat wins)', () => {
    expect(resolveGate([worldRow(true), chatRow(false)], 'w', 'c').open).toBe(false)
  })

  it('chat row OPEN overrides world row CLOSED', () => {
    expect(resolveGate([worldRow(false), chatRow(true)], 'w', 'c').open).toBe(true)
  })

  it('a chat row for a DIFFERENT chat does not apply; the world row governs', () => {
    expect(resolveGate([worldRow(true), chatRow(false)], 'w', 'other').open).toBe(true)
  })

  it('threads the winning row denial set', () => {
    expect(resolveGate([worldRow(true), chatRow(true, [0, 2])], 'w', 'c').denial).toEqual([0, 2])
  })

  it('a row for a different world is ignored', () => {
    const other: ActivationRow = { packId: 'p', worldId: 'w2', chatId: null, gateOpen: true, denial: [], pinVersion: 3 }
    expect(resolveGate([other], 'w', 'c').open).toBe(false)
  })

  // WP4.6: resolveGate returns the WINNING row's pinned version (chat row wins over world row).
  it('returns the winning row pinVersion (chat pin wins over world pin)', () => {
    expect(resolveGate([worldRow(true, 2), chatRow(true, [], 4)], 'w', 'c').pinVersion).toBe(4)
    // No chat row → the world row's pin governs.
    expect(resolveGate([worldRow(true, 2)], 'w', 'c').pinVersion).toBe(2)
  })
})

// WP4.6: pickPinnedRecord selects which coexisting version composes for a resolved gate.
describe('pickPinnedRecord (version coexistence)', () => {
  const rec = (version: number): AgentPackRecord => ({
    id: 'p', version, upstreamId: null, upstreamVersion: null, builtin: false,
    manifest: { name: 'P' }, fragment
  })

  it('picks the pinned version when installed', () => {
    expect(pickPinnedRecord([rec(1), rec(2), rec(3)], 2)?.version).toBe(2)
  })

  it('falls back to the HIGHEST installed version when the pin is null (legacy/unpinned row)', () => {
    expect(pickPinnedRecord([rec(1), rec(4), rec(2)], null)?.version).toBe(4)
  })

  it('falls back to the highest when the pin points at an UNINSTALLED version', () => {
    expect(pickPinnedRecord([rec(1), rec(2)], 9)?.version).toBe(2)
  })

  it('undefined for an empty set', () => {
    expect(pickPinnedRecord([], 1)).toBeUndefined()
  })
})

describe('encodeScope', () => {
  it('encodes the three ADR-0005 tiers', () => {
    expect(encodeScope('global')).toBe('global')
    expect(encodeScope({ world: 'w1' })).toBe('world:w1')
    expect(encodeScope({ chat: 'c1' })).toBe('chat:c1')
  })
})

describe('layerOverrides (nearest-scope-wins: global < world < chat)', () => {
  const rows: OverrideRow[] = [
    { packId: 'p', scope: 'global', settingId: 'tone', value: 'g' },
    { packId: 'p', scope: 'global', settingId: 'budget', value: 100 },
    { packId: 'p', scope: 'world:w', settingId: 'tone', value: 'w' },
    { packId: 'p', scope: 'chat:c', settingId: 'tone', value: 'c' }
  ]

  it('chat wins over world wins over global for the same setting', () => {
    expect(layerOverrides(rows, 'w', 'c').tone).toBe('c')
  })

  it('a broad-tier-only setting survives (budget from global)', () => {
    expect(layerOverrides(rows, 'w', 'c').budget).toBe(100)
  })

  it('without a chat, the world tier wins', () => {
    expect(layerOverrides(rows, 'w', null).tone).toBe('w')
  })

  it('without world or chat, only global applies', () => {
    expect(layerOverrides(rows, null, null)).toEqual({ tone: 'g', budget: 100 })
  })

  it('scopes for a different world/chat are ignored', () => {
    expect(layerOverrides(rows, 'otherWorld', 'otherChat')).toEqual({ tone: 'g', budget: 100 })
  })
})

// Provenance resolution (agent-packs plan WP3.2) — the settings-UI read side: winning value + the
// scope it came from + each scope's raw value (for "clearing chat reveals world").
describe('layerOverridesWithProvenance', () => {
  const rows: OverrideRow[] = [
    { packId: 'p', scope: 'global', settingId: 'tone', value: 'g' },
    { packId: 'p', scope: 'global', settingId: 'budget', value: 100 },
    { packId: 'p', scope: 'world:w', settingId: 'tone', value: 'w' },
    { packId: 'p', scope: 'chat:c', settingId: 'tone', value: 'c' }
  ]

  it('tags the winning scope: chat > world > global', () => {
    const r = layerOverridesWithProvenance(rows, 'w', 'c')
    expect(r.tone).toMatchObject({ value: 'c', provenance: 'chat' })
    // Exposes each scope's raw value so the UI can preview a reset.
    expect(r.tone).toMatchObject({ globalValue: 'g', worldValue: 'w', chatValue: 'c' })
  })

  it('a global-only setting has provenance global', () => {
    const r = layerOverridesWithProvenance(rows, 'w', 'c')
    expect(r.budget).toMatchObject({ value: 100, provenance: 'global', globalValue: 100 })
    expect(r.budget.worldValue).toBeUndefined()
  })

  it('without a chat, world wins and no chatValue is recorded', () => {
    const r = layerOverridesWithProvenance(rows, 'w', null)
    expect(r.tone).toMatchObject({ value: 'w', provenance: 'world' })
    expect(r.tone.chatValue).toBeUndefined()
  })

  it('a setting with no applicable override is absent from the map (defaults to default upstream)', () => {
    const r = layerOverridesWithProvenance(rows, 'otherWorld', 'otherChat')
    // Only global scopes apply for a different world/chat.
    expect(r.tone).toMatchObject({ value: 'g', provenance: 'global' })
    expect(r.budget).toMatchObject({ value: 100, provenance: 'global' })
  })
})

// Sanity: an AgentPackRecord round-trips through rowToPack from what a real install would write.
describe('record shape', () => {
  it('is a fragment-kind WorkflowDoc carrying doc', () => {
    const pack: AgentPackRecord = {
      id: 'p',
      version: 1,
      upstreamId: null,
      upstreamVersion: null,
      builtin: false,
      manifest: { name: 'n' },
      fragment
    }
    expect(pack.fragment.attachments?.length).toBe(1)
  })
})
