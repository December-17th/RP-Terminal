// Classic Narrator first execution plan — Milestone 2, part B.
//
// Milestone 3 depends on two claims that were INFERRED rather than traced. This file resolves both
// against real production composition, because both turned out to be more qualified than assumed:
//
//  1. "Pack composition adds no nodes for a default Classic turn."
//     NOT because the zero-fragments default provider is what production runs — production runs the
//     REAL provider (`agentPackService.ts` calls `setEnabledFragmentsProvider(enabledFragmentsFor)`
//     as an import-time side effect). It adds no nodes because every pack's GATE IS CLOSED BY
//     DEFAULT: seeding installs a library row but writes no activation row, and "no row = closed".
//     Open one gate and nodes ARE spliced into the turn graph.
//
//  2. "No detached work" is specific to the doc, and the doc is NOT BUILTIN_DEFAULT_DOC.
//     A real profile resolves a profile-SAVED, user-editable copy of the same template (seeded by
//     `seedDefaultMemoryWorkflow` and selected globally); BUILTIN_DEFAULT_DOC is only the final
//     fallback. The saved copy has the same node/edge shape, so the Milestone 2 inventory holds for
//     it — but it is editable, so the empty post phase is not guaranteed by resolution.
//     (That an edited doc really does populate the post phase is proven in classicTurnInventory.test.ts.)
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { WorkflowDoc } from '../../src/shared/workflow/types'
import { AgentPackRecord, ActivationRow, OverrideRow } from '../../src/main/services/agentPackStore'

// The pack store is native SQLite (unloadable under Node), so the STORE is faked in memory — the
// same seam agentPackService.test.ts uses. The pure resolution helpers stay REAL: `resolveGate` is
// the actual authority for "is this pack on", and claim 1 rests on it.
const {
  encodeScope: realEncodeScope,
  resolveGate: realResolveGate,
  pickPinnedRecord: realPickPinnedRecord,
  layerOverrides: realLayerOverrides
} = await vi.importActual<typeof import('../../src/main/services/agentPackStore')>(
  '../../src/main/services/agentPackStore'
)

const state = vi.hoisted(() => ({
  packs: [] as AgentPackRecord[],
  activation: [] as ActivationRow[],
  overrides: [] as OverrideRow[]
}))

const store = vi.hoisted(() => ({
  encodeScope: vi.fn(),
  getPackIdentity: vi.fn(),
  getPackRecord: vi.fn(),
  listPackVersions: vi.fn(),
  insertPack: vi.fn(),
  deletePackVersion: vi.fn(),
  deletePackVersionAgnosticRows: vi.fn(),
  listPackRecords: vi.fn(),
  packToSummary: vi.fn(),
  pickPinnedRecord: vi.fn(),
  listActivationRows: vi.fn(),
  upsertGate: vi.fn(),
  setActivePinVersion: vi.fn(),
  resolveGate: vi.fn(),
  listOverrideRows: vi.fn(),
  upsertOverride: vi.fn(),
  deleteOverride: vi.fn(),
  layerOverrides: vi.fn(),
  layerOverridesWithProvenance: vi.fn(),
  insertActivationRow: vi.fn(),
  deleteActivationForWorld: vi.fn(),
  insertOverrideRow: vi.fn(),
  updatePackFragmentRow: vi.fn()
}))
vi.mock('../../src/main/services/agentPackStore', () => store)
vi.mock('../../src/main/services/agentPackTriggerStore', () => ({
  deleteTriggerStateForPack: vi.fn()
}))

const mockChatService = vi.hoisted(() => ({
  getChat: vi.fn<(p: string, c: string) => { character_id: string } | null>(() => null),
  getChatWorkflowId: vi.fn<() => string | null>(() => null),
  removeWorkflowIdFromChats: vi.fn(),
  setChatWorkflowId: vi.fn()
}))
vi.mock('../../src/main/services/chatService', () => mockChatService)
vi.mock('../../src/main/services/logService', () => ({ log: vi.fn() }))

// workflowService and agentPackService are BOTH REAL — importing agentPackService is what installs
// the production provider onto workflowService's seam. That import IS the evidence for claim 1.
import {
  resolveWorkflowDoc,
  resolveEffectiveDoc,
  setEnabledFragmentsProvider,
  setMemorySeedingEnabled,
  resetMemorySeedGuardForTest,
  listWorkflows,
  getSelection,
  saveWorkflow,
  createWorkflowFromDoc,
  setGlobalWorkflow,
  BUILTIN_WORKFLOW_ID,
  BUILTIN_DEFAULT_DOC
} from '../../src/main/services/workflowService'
import * as packService from '../../src/main/services/agentPackService'
import { getAppDir } from '../../src/main/services/storageService'
import {
  buildDefaultMemoryDocV2,
  DEFAULT_MEMORY_SEED_MARKER_V2
} from '../../src/main/services/nodes/builtin/defaultMemoryTemplate'

const profiles: string[] = []
const freshProfile = (): string => {
  const id = `classic-m2-${randomUUID()}`
  profiles.push(id)
  return id
}
afterAll(() => {
  for (const id of profiles)
    fs.rmSync(path.join(getAppDir(), 'profiles', id), { recursive: true, force: true })
})

beforeEach(() => {
  state.packs = []
  state.activation = []
  state.overrides = []
  vi.clearAllMocks()
  store.encodeScope.mockImplementation(realEncodeScope)
  store.resolveGate.mockImplementation(realResolveGate)
  store.pickPinnedRecord.mockImplementation(realPickPinnedRecord)
  store.layerOverrides.mockImplementation(realLayerOverrides)
  store.listPackRecords.mockImplementation(() => state.packs)
  store.listActivationRows.mockImplementation((packId: string) =>
    state.activation.filter((r) => r.packId === packId)
  )
  store.listOverrideRows.mockImplementation(() => state.overrides)
  store.insertPack.mockImplementation((_p: string, rec: AgentPackRecord) => {
    if (!state.packs.some((x) => x.id === rec.id && x.version === rec.version)) state.packs.push(rec)
  })
  mockChatService.getChat.mockReturnValue({ character_id: 'world-1' })
  mockChatService.getChatWorkflowId.mockReturnValue(null)
  setMemorySeedingEnabled(false)
  resetMemorySeedGuardForTest()
  // Restore PRODUCTION wiring before every test. Resetting the seam to the zero-fragments default in
  // an afterEach (the earlier shape of this file) silently killed every effective-doc assertion from
  // the second test onward: with `() => []` installed, `resolveEffectiveDoc` can never compose, so
  // the node-identity checks below would have passed even if gate resolution regressed to
  // always-open. The seam must carry the real provider for those assertions to bite.
  setEnabledFragmentsProvider(packService.enabledFragmentsFor)
})
afterEach(() => setMemorySeedingEnabled(true))
// Hand the seam back to the zero-packs default once, after this file is done.
afterAll(() => setEnabledFragmentsProvider())

/** A minimal fragment pack: one node, attached at the context-ready checkpoint. */
const fragmentPack = (id = 'pack-1'): AgentPackRecord =>
  ({
    id,
    version: 1,
    builtin: false,
    manifest: { id, name: 'Test Pack', version: 1 },
    fragment: {
      id: `${id}-frag`,
      name: 'Test Fragment',
      version: 1,
      schemaVersion: 1,
      kind: 'fragment',
      attachments: [{ checkpoint: 'context-ready', mode: 'branch' }],
      nodes: [{ id: 'probe', type: 'util.log', config: { label: 'probe' } }],
      edges: []
    }
  }) as unknown as AgentPackRecord

// ── CLAIM 1: pack composition on a default Classic turn ───────────────────────────────────────────

describe('Claim 1 — pack composition adds no nodes to a DEFAULT Classic turn', () => {
  it('production registers the REAL provider, not the zero-fragments default', () => {
    // The correction to the inferred claim: `agentPackService.ts` calls
    // setEnabledFragmentsProvider(enabledFragmentsFor) at module scope, so simply importing it (which
    // production does, via registerAgentPackIpc) replaces the default `() => []`. Evidence is
    // behavioral: with a gate-open pack in the library the effective doc GAINS nodes, which is only
    // possible if the real provider is the one installed on the seam.
    state.packs = [fragmentPack()]
    state.activation = [
      { packId: 'pack-1', worldId: 'world-1', chatId: null, gateOpen: true, denial: [], pinVersion: 1 } as ActivationRow
    ]

    const profileId = freshProfile()
    const base = resolveWorkflowDoc(profileId, 'chat-1')
    const effective = resolveEffectiveDoc(profileId, 'chat-1')

    expect(effective.doc.nodes.length).toBeGreaterThan(base.doc.nodes.length)
    expect(effective.doc.nodes.some((n) => n.id.startsWith('pack:pack-1:'))).toBe(true)
  })

  it('a fresh profile seeds an EMPTY pack library and no activation row at all', () => {
    // Two independent reasons a default install composes nothing, both stronger than assumed:
    //  · BUILTIN_PACKS is empty (one-canvas rebuild WP6.2 / ADR 0011 — the memory experiences ship as
    //    example workflow DOCS now, not seeded packs), so seeding installs no pack whatsoever;
    //  · even a pack that IS installed gets no activation row, and "no row = gate closed".
    packService.seedBuiltinPacks(freshProfile())

    expect(state.packs).toEqual([]) // nothing is seeded into a fresh library
    expect(state.activation).toEqual([]) // and no gate is opened
    // The gate rule itself, on the real resolver: absent any row, closed.
    expect(realResolveGate([], 'world-1', 'chat-1')).toEqual({
      open: false,
      denial: [],
      pinVersion: null
    })
  })

  it('an installed pack contributes no FRAGMENT until its gate is explicitly opened', () => {
    state.packs = [fragmentPack()] // installed (user import) but never activated

    expect(packService.enabledFragmentsFor(freshProfile(), 'chat-1')).toEqual([])
  })

  it('and contributes no NODES to the effective doc either', () => {
    // Deliberately a SEPARATE test from the one above rather than a second assertion inside it: with
    // both in one test the fragment assertion throws first and this one never executes, so a gate
    // regression would leave it silently unproven. Split, it bites on its own.
    state.packs = [fragmentPack()]
    const profileId = freshProfile()

    expect(resolveEffectiveDoc(profileId, 'chat-1').doc.nodes.map((n) => n.id)).toEqual(
      resolveWorkflowDoc(profileId, 'chat-1').doc.nodes.map((n) => n.id)
    )
  })

  it('so the DEFAULT turn composes ZERO fragments and the effective doc is node-identical', () => {
    const profileId = freshProfile()

    expect(packService.enabledFragmentsFor(profileId, 'chat-1')).toEqual([])

    const base = resolveWorkflowDoc(profileId, 'chat-1')
    const effective = resolveEffectiveDoc(profileId, 'chat-1')

    // The Milestone 2 inventory (8 nodes) is therefore the WHOLE turn on a default install.
    expect(effective.doc.nodes.map((n) => n.id)).toEqual(base.doc.nodes.map((n) => n.id))
    expect(effective.doc.edges).toEqual(base.doc.edges)
    expect(effective.warnings).toEqual([])
  })

  it('a chat with no resolvable world composes zero fragments even with an open gate', () => {
    state.packs = [fragmentPack()]
    state.activation = [
      { packId: 'pack-1', worldId: 'world-1', chatId: null, gateOpen: true, denial: [], pinVersion: 1 } as ActivationRow
    ]
    mockChatService.getChat.mockReturnValue(null) // no world → no open gates

    expect(packService.enabledFragmentsFor(freshProfile(), 'chat-1')).toEqual([])
  })
})

// ── CLAIM 2: which doc a real production Classic turn actually resolves ───────────────────────────

describe('Claim 2 — a real profile resolves a SAVED doc, not BUILTIN_DEFAULT_DOC', () => {
  it('falls back to the builtin only when every selection tier misses', () => {
    const { id, doc } = resolveWorkflowDoc(freshProfile(), 'chat-1')

    expect(id).toBe(BUILTIN_WORKFLOW_ID)
    expect(doc).toBe(BUILTIN_DEFAULT_DOC)
  })

  it('seeding writes an EDITABLE profile doc and selects it globally — production resolves THAT', () => {
    const profileId = freshProfile()
    setMemorySeedingEnabled(true)
    resetMemorySeedGuardForTest()

    listWorkflows(profileId) // the real lazy-seed entry point

    const selection = getSelection(profileId)
    expect(selection.global).not.toBeNull()
    expect(selection.global).not.toBe(BUILTIN_WORKFLOW_ID)

    const resolved = resolveWorkflowDoc(profileId, 'chat-1')
    // The correction to the inferred claim: this is a profile FILE, not the read-only builtin.
    expect(resolved.id).toBe(selection.global)
    expect(resolved.doc).not.toBe(BUILTIN_DEFAULT_DOC)
    expect(resolved.doc.meta).toMatchObject({ seeded: DEFAULT_MEMORY_SEED_MARKER_V2 })
  })

  it('but the seeded doc has the SAME node/edge shape, so the Milestone 2 inventory holds for it', () => {
    const profileId = freshProfile()
    setMemorySeedingEnabled(true)
    resetMemorySeedGuardForTest()
    listWorkflows(profileId)

    const resolved = resolveWorkflowDoc(profileId, 'chat-1')

    // Identical graph; only `id` and `meta.seeded` differ from the builtin fallback.
    expect(resolved.doc.nodes.map((n) => `${n.id}:${n.type}`)).toEqual(
      BUILTIN_DEFAULT_DOC.nodes.map((n) => `${n.id}:${n.type}`)
    )
    expect(resolved.doc.edges).toEqual(BUILTIN_DEFAULT_DOC.edges)
    expect(resolved.doc.nodes.find((n) => n.isMainOutput)?.id).toBe('write')
  })

  it('a user-EDITED saved doc is resolved verbatim — a post-phase node survives resolution', () => {
    // The consequence Milestone 3 must own: nothing in resolution constrains the doc to the default
    // shape. A user who adds a node downstream of `write` gets detached post-phase work inside
    // runWorkflow (proven to actually RUN in classicTurnInventory.test.ts).
    const profileId = freshProfile()
    const edited = buildDefaultMemoryDocV2() as WorkflowDoc
    edited.nodes.push({ id: 'after-write', type: 'util.log', config: { label: 'post' } })
    edited.edges.push({ from: { node: 'write', port: 'floor' }, to: { node: 'after-write', port: 'value' } })

    const created = createWorkflowFromDoc(profileId, edited)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    setGlobalWorkflow(profileId, created.id)

    const resolved = resolveWorkflowDoc(profileId, 'chat-1')

    expect(resolved.id).toBe(created.id)
    expect(resolved.doc.nodes.some((n) => n.id === 'after-write')).toBe(true)
    // It passed the same save gate production uses — this is a legal, reachable production doc.
    expect(saveWorkflow(profileId, created.id, resolved.doc).ok).toBe(true)
  })

  it('the session tier outranks global, so a chat can run a different doc entirely', () => {
    const profileId = freshProfile()
    const globalDoc = createWorkflowFromDoc(profileId, buildDefaultMemoryDocV2())
    const sessionDoc = createWorkflowFromDoc(profileId, {
      ...buildDefaultMemoryDocV2(),
      name: 'Session Override'
    })
    expect(globalDoc.ok && sessionDoc.ok).toBe(true)
    if (!globalDoc.ok || !sessionDoc.ok) return
    setGlobalWorkflow(profileId, globalDoc.id)
    mockChatService.getChatWorkflowId.mockReturnValue(sessionDoc.id)

    expect(resolveWorkflowDoc(profileId, 'chat-1').id).toBe(sessionDoc.id)
  })
})
