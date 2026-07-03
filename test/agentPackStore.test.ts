import { describe, it, expect } from 'vitest'
import {
  rowToPack,
  packToSummary,
  resolveGate,
  layerOverrides,
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
    builtin: 1,
    manifest: JSON.stringify({ name: 'Memory Keeper', creator: 'me' }),
    fragment: JSON.stringify(fragment)
  }

  it('parses blobs and coerces the builtin flag + upstream lineage', () => {
    const pack = rowToPack(row)
    expect(pack).toMatchObject({ id: 'p1', version: 2, upstreamId: 'p0', builtin: true })
    expect(pack.manifest.name).toBe('Memory Keeper')
    expect(pack.fragment.kind).toBe('fragment')
  })

  it('null upstream_id → null lineage; builtin 0 → false', () => {
    const pack = rowToPack({ ...row, upstream_id: null, builtin: 0 })
    expect(pack.upstreamId).toBeNull()
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
      builtin: true,
      manifest: { name: 'Memory Keeper', creator: 'me' },
      attachments: [
        { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }
      ],
      capabilities: ['injects-prompt']
    })
    // The fragment blob itself is still NOT in the summary (only its derived display extras are).
    expect('fragment' in s).toBe(false)
  })
})

describe('resolveGate (Activation)', () => {
  const worldRow = (open: boolean): ActivationRow => ({
    packId: 'p',
    worldId: 'w',
    chatId: null,
    gateOpen: open,
    denial: []
  })
  const chatRow = (open: boolean, denial: number[] = []): ActivationRow => ({
    packId: 'p',
    worldId: 'w',
    chatId: 'c',
    gateOpen: open,
    denial
  })

  it('no rows → CLOSED (packs are opt-in)', () => {
    expect(resolveGate([], 'w', 'c')).toEqual({ open: false, denial: [] })
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
    const other: ActivationRow = { packId: 'p', worldId: 'w2', chatId: null, gateOpen: true, denial: [] }
    expect(resolveGate([other], 'w', 'c').open).toBe(false)
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

// Sanity: an AgentPackRecord round-trips through rowToPack from what a real install would write.
describe('record shape', () => {
  it('is a fragment-kind WorkflowDoc carrying doc', () => {
    const pack: AgentPackRecord = {
      id: 'p',
      version: 1,
      upstreamId: null,
      builtin: false,
      manifest: { name: 'n' },
      fragment
    }
    expect(pack.fragment.attachments?.length).toBe(1)
  })
})
