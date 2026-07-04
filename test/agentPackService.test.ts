import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkflowDoc } from '../src/shared/workflow/types'
import { AgentPackRecord, ActivationRow, OverrideRow } from '../src/main/services/agentPackStore'

// agentPackService orchestrates the SQLite store + chatService. The store's native SQL can't run
// under Node (better-sqlite3 stub), so we mock the store MODULE with in-memory fakes and pin the
// service's orchestration logic: dedupe, builtin-uninstall refusal, gate/override delegation, and
// the enabledFragmentsFor provider (gating + duplicate guard + denial threading). encodeScope +
// the pure resolution helpers are re-used from the real module (they are pure).

const {
  encodeScope: realEncodeScope,
  resolveGate: realResolveGate,
  layerOverrides: realLayerOverrides,
  layerOverridesWithProvenance: realLayerOverridesWithProvenance
} = await vi.importActual<typeof import('../src/main/services/agentPackStore')>(
  '../src/main/services/agentPackStore'
)

// In-memory store state the mocked wrappers read/write.
const state = vi.hoisted(() => ({
  packs: [] as AgentPackRecord[],
  activation: [] as ActivationRow[],
  overrides: [] as OverrideRow[]
}))

const store = vi.hoisted(() => ({
  encodeScope: vi.fn(),
  getPackIdentity: vi.fn(),
  getPackRecord: vi.fn(),
  insertPack: vi.fn(),
  deletePack: vi.fn(),
  listPackRecords: vi.fn(),
  packToSummary: vi.fn(),
  listActivationRows: vi.fn(),
  upsertGate: vi.fn(),
  resolveGate: vi.fn(),
  listOverrideRows: vi.fn(),
  upsertOverride: vi.fn(),
  deleteOverride: vi.fn(),
  layerOverrides: vi.fn(),
  layerOverridesWithProvenance: vi.fn(),
  // Fork wrappers (agent-packs plan WP3.6a).
  insertActivationRow: vi.fn(),
  deleteActivationForWorld: vi.fn(),
  insertOverrideRow: vi.fn(),
  // Fragment write-through (agent-packs plan WP3.6b).
  updatePackFragmentRow: vi.fn()
}))

vi.mock('../src/main/services/agentPackStore', () => store)

// The trigger-state store is a SEPARATE sqlite surface (native binary can't load under Node); the
// service calls deleteTriggerStateForPack on uninstall (WP4.3b). Mock it so we can assert the prune.
const triggerStore = vi.hoisted(() => ({ deleteTriggerStateForPack: vi.fn() }))
vi.mock('../src/main/services/agentPackTriggerStore', () => triggerStore)

const mockChatService = vi.hoisted(() => ({
  getChat: vi.fn<(profileId: string, chatId: string) => { character_id: string } | null>(() => null),
  // workflowService.resolveWorkflowDoc (real) also reads the session-tier workflow override.
  getChatWorkflowId: vi.fn<() => string | null>(() => null)
}))
vi.mock('../src/main/services/chatService', () => mockChatService)

// Silence log noise from the dedupe/uninstall/duplicate paths and let us assert it fired.
const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)

// workflowService is REAL — importing agentPackService registers enabledFragmentsFor on its
// provider seam at module load. We reset that seam to default after every test.
import { resolveEffectiveDoc, setEnabledFragmentsProvider, BUILTIN_WORKFLOW_ID } from '../src/main/services/workflowService'
import * as service from '../src/main/services/agentPackService'

const pack = (over: Partial<AgentPackRecord> = {}): AgentPackRecord => ({
  id: 'p1',
  version: 1,
  upstreamId: null,
  builtin: false,
  manifest: { name: 'Pack One' },
  fragment: {
    id: 'frag',
    name: 'F',
    version: 1,
    schemaVersion: 1,
    kind: 'fragment',
    nodes: [{ id: 'blk', type: 'text.template' }],
    edges: [],
    attachments: [
      { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }
    ]
  } as WorkflowDoc,
  ...over
})

beforeEach(() => {
  state.packs = []
  state.activation = []
  state.overrides = []
  Object.values(store).forEach((fn) => fn.mockReset())
  mockChatService.getChat.mockReset().mockReturnValue({ character_id: 'w1' })
  mockChatService.getChatWorkflowId.mockReset().mockReturnValue(null)
  mockLog.log.mockReset()
  triggerStore.deleteTriggerStateForPack.mockReset()

  // Wire the mocked store to the in-memory state + real pure helpers.
  store.encodeScope.mockImplementation(realEncodeScope)
  store.resolveGate.mockImplementation(realResolveGate)
  store.layerOverrides.mockImplementation(realLayerOverrides)
  store.layerOverridesWithProvenance.mockImplementation(realLayerOverridesWithProvenance)
  store.listPackRecords.mockImplementation(() => state.packs)
  store.getPackIdentity.mockImplementation((_p, id) => {
    const found = state.packs.find((x) => x.id === id)
    return found ? { id: found.id, version: found.version } : null
  })
  store.getPackRecord.mockImplementation((_p, id) => state.packs.find((x) => x.id === id) ?? null)
  store.insertPack.mockImplementation((_p, x) => state.packs.push(x))
  store.deletePack.mockImplementation((_p, id) => {
    const before = state.packs.length
    state.packs = state.packs.filter((x) => x.id !== id)
    return state.packs.length < before
  })
  store.packToSummary.mockImplementation((x) => ({
    id: x.id,
    version: x.version,
    upstreamId: x.upstreamId,
    builtin: x.builtin,
    manifest: x.manifest
  }))
  store.listActivationRows.mockImplementation((id) => state.activation.filter((r) => r.packId === id))
  store.listOverrideRows.mockImplementation((id) => state.overrides.filter((r) => r.packId === id))
  // Fork wrappers over the in-memory state.
  store.insertActivationRow.mockImplementation((row: ActivationRow) => state.activation.push({ ...row }))
  store.deleteActivationForWorld.mockImplementation((packId: string, worldId: string) => {
    state.activation = state.activation.filter((r) => !(r.packId === packId && r.worldId === worldId))
  })
  store.insertOverrideRow.mockImplementation((packId: string, scope: string, settingId: string, value: unknown) =>
    state.overrides.push({ packId, scope, settingId, value })
  )
  store.updatePackFragmentRow.mockImplementation((_p: string, packId: string, fragment: WorkflowDoc) => {
    const target = state.packs.find((x) => x.id === packId)
    if (!target) return false
    target.fragment = fragment
    return true
  })
})

afterEach(() => setEnabledFragmentsProvider()) // restore the zero-packs default provider

describe('install / dedupe / uninstall', () => {
  it('installs a new pack', () => {
    const r = service.install('prof', pack())
    expect(r.installed).toBe(true)
    expect(state.packs).toHaveLength(1)
  })

  it('installing an already-installed id+version is a no-op returning the existing row (dedupe)', () => {
    service.install('prof', pack())
    const r = service.install('prof', pack())
    expect(r.installed).toBe(false)
    expect(state.packs).toHaveLength(1)
    expect(r.pack.id).toBe('p1')
  })

  it('uninstall removes a non-builtin pack and prunes its trigger-state (WP4.3b)', () => {
    service.install('prof', pack())
    expect(service.uninstall('prof', 'p1')).toEqual({ ok: true })
    expect(state.packs).toHaveLength(0)
    // deletePack drops activation + override rows; the service also prunes the trigger-state store.
    expect(triggerStore.deleteTriggerStateForPack).toHaveBeenCalledWith('p1')
  })

  it('uninstall REFUSES a builtin pack (uninstallable) and logs, pruning nothing', () => {
    service.install('prof', pack({ builtin: true }))
    expect(service.uninstall('prof', 'p1')).toEqual({ ok: false, code: 'builtin' })
    expect(state.packs).toHaveLength(1)
    expect(mockLog.log).toHaveBeenCalled()
    expect(triggerStore.deleteTriggerStateForPack).not.toHaveBeenCalled()
  })

  it('uninstall of an unknown pack returns not-found and prunes nothing', () => {
    expect(service.uninstall('prof', 'nope')).toEqual({ ok: false, code: 'not-found' })
    expect(triggerStore.deleteTriggerStateForPack).not.toHaveBeenCalled()
  })
})

describe('gate delegation', () => {
  it('getGate: no rows → closed', () => {
    expect(service.getGate('p1', 'w1', 'c1')).toBe(false)
  })

  it('getGate: chat row closed overrides world row open', () => {
    state.activation = [
      { packId: 'p1', worldId: 'w1', chatId: null, gateOpen: true, denial: [] },
      { packId: 'p1', worldId: 'w1', chatId: 'c1', gateOpen: false, denial: [] }
    ]
    expect(service.getGate('p1', 'w1', 'c1')).toBe(false)
    expect(service.getGate('p1', 'w1', null)).toBe(true)
  })

  it('setGate delegates to the store upsert', () => {
    service.setGate('p1', 'w1', null, true)
    expect(store.upsertGate).toHaveBeenCalledWith('p1', 'w1', null, true)
  })
})

describe('override delegation + resolution', () => {
  it('setOverride encodes the scope before writing', () => {
    service.setOverride('p1', { chat: 'c1' }, 'tone', 'x')
    expect(store.upsertOverride).toHaveBeenCalledWith('p1', 'chat:c1', 'tone', 'x')
  })

  it('clearOverride removes exactly one scope (delegates encoded scope)', () => {
    service.clearOverride('p1', { world: 'w1' }, 'tone')
    expect(store.deleteOverride).toHaveBeenCalledWith('p1', 'world:w1', 'tone')
  })

  it('resolveOverrides layers global < world < chat', () => {
    state.overrides = [
      { packId: 'p1', scope: 'global', settingId: 'tone', value: 'g' },
      { packId: 'p1', scope: 'world:w1', settingId: 'tone', value: 'w' },
      { packId: 'p1', scope: 'chat:c1', settingId: 'tone', value: 'c' }
    ]
    expect(service.resolveOverrides('p1', 'w1', 'c1').tone).toBe('c')
    expect(service.resolveOverrides('p1', 'w1', null).tone).toBe('w')
    expect(service.resolveOverrides('p1', null, null).tone).toBe('g')
  })
})

describe('enabledFragmentsFor', () => {
  it('unknown chat (no world) → no fragments', () => {
    mockChatService.getChat.mockReturnValue(null)
    state.packs = [pack()]
    expect(service.enabledFragmentsFor('prof', 'c1')).toEqual([])
  })

  it('only OPEN-gated packs contribute', () => {
    state.packs = [pack({ id: 'open' }), pack({ id: 'closed' })]
    state.activation = [{ packId: 'open', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]
    const frags = service.enabledFragmentsFor('prof', 'c1')
    expect(frags.map((f) => f.packId)).toEqual(['open'])
    expect(frags[0].gateOpen).toBe(true)
  })

  it('threads closedEntryIndexes from the winning activation denial JSON', () => {
    state.packs = [pack()]
    state.activation = [{ packId: 'p1', worldId: 'w1', chatId: null, gateOpen: true, denial: [0, 3] }]
    const [frag] = service.enabledFragmentsFor('prof', 'c1')
    expect(frag.closedEntryIndexes).toEqual([0, 3])
  })

  it('omits closedEntryIndexes when there is no denial', () => {
    state.packs = [pack()]
    state.activation = [{ packId: 'p1', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]
    const [frag] = service.enabledFragmentsFor('prof', 'c1')
    expect('closedEntryIndexes' in frag).toBe(false)
  })

  it('duplicate packId → keeps first, DROPS + LOGS the duplicate', () => {
    // Two library rows sharing an id (the guard is defensive vs the PK). Both gated open.
    state.packs = [pack({ id: 'dup' }), pack({ id: 'dup' })]
    state.activation = [{ packId: 'dup', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]
    const frags = service.enabledFragmentsFor('prof', 'c1')
    expect(frags).toHaveLength(1)
    expect(mockLog.log).toHaveBeenCalled()
  })

  // ── MATERIALIZATION on the turn path (agent-packs plan WP3.2) ─────────────────────────────────────
  // The composition provider must materialize resolved overrides into the fragment BEFORE returning
  // ComposeFragments. This is the turn call site; the headless evaluator reads the SAME ComposeFragment
  // (evaluatePass/runHeadless), so covering it here covers both paths.
  const settablePack = (): AgentPackRecord =>
    pack({
      id: 'settable',
      manifest: {
        name: 'Settable',
        exposedSettings: [
          { id: 'blk.count', label: 'count', type: 'number', default: 3, min: 1, max: 10, target: { nodeId: 'blk', path: 'count' } }
        ]
      },
      fragment: {
        id: 'sf', name: 'sf', version: 1, schemaVersion: 1, kind: 'fragment',
        nodes: [{ id: 'blk', type: 'text.template', config: { count: 3 } }],
        edges: [],
        attachments: [{ kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }]
      } as WorkflowDoc
    })

  it('materializes a resolved override into the returned fragment doc (world scope wins)', () => {
    state.packs = [settablePack()]
    state.activation = [{ packId: 'settable', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]
    state.overrides = [{ packId: 'settable', scope: 'world:w1', settingId: 'blk.count', value: 7 }]
    const [frag] = service.enabledFragmentsFor('prof', 'c1')
    const node = frag.doc.nodes.find((n) => n.id === 'blk')
    expect(node?.config?.count).toBe(7)
  })

  it('with no override the returned fragment keeps the pack default (zero change)', () => {
    const p = settablePack()
    state.packs = [p]
    state.activation = [{ packId: 'settable', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]
    const [frag] = service.enabledFragmentsFor('prof', 'c1')
    expect(frag.doc).toEqual(p.fragment)
  })

  it('clamps an out-of-range override on the turn path', () => {
    state.packs = [settablePack()]
    state.activation = [{ packId: 'settable', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]
    state.overrides = [{ packId: 'settable', scope: 'world:w1', settingId: 'blk.count', value: 999 }]
    const [frag] = service.enabledFragmentsFor('prof', 'c1')
    expect(frag.doc.nodes.find((n) => n.id === 'blk')?.config?.count).toBe(10)
  })
})

describe('getPackSettings (detail-panel model; WP3.2)', () => {
  it('returns creator-exposed + resolved provenance for an installed pack', () => {
    const p = pack({
      id: 'gp',
      manifest: {
        name: 'GP',
        exposedSettings: [
          { id: 'blk.count', label: { en: 'Count', zh: '数量' }, type: 'number', default: 3, target: { nodeId: 'blk', path: 'count' } }
        ]
      }
    })
    state.packs = [p]
    state.overrides = [{ packId: 'gp', scope: 'world:w1', settingId: 'blk.count', value: 5 }]
    const res = service.getPackSettings('prof', 'gp', 'w1', 'c1')
    expect(res).not.toBeNull()
    const s = res!.packSettings.find((x) => x.id === 'blk.count')!
    expect(s.resolved).toMatchObject({ value: 5, provenance: 'world' })
    // No trigger → System group empty.
    expect(res!.hasTriggers).toBe(false)
  })

  it('a defaulted setting resolves to the schema default with provenance default', () => {
    const p = pack({
      id: 'gp2',
      manifest: {
        name: 'GP2',
        exposedSettings: [
          { id: 'blk.count', label: 'Count', type: 'number', default: 3, target: { nodeId: 'blk', path: 'count' } }
        ]
      }
    })
    state.packs = [p]
    const res = service.getPackSettings('prof', 'gp2', 'w1', 'c1')!
    const s = res.packSettings[0]
    expect(s.resolved).toMatchObject({ value: 3, provenance: 'default' })
  })

  it('returns null for a pack that is not installed', () => {
    expect(service.getPackSettings('prof', 'missing', 'w1', 'c1')).toBeNull()
  })
})

describe('built-in pack seeding (WP1.6)', () => {
  const TABLE_MEMORY = 'builtin.table-memory'

  it('seedBuiltinPacks installs the table-memory pack as a builtin (idempotent)', () => {
    service.seedBuiltinPacks('seed-prof-1')
    const listed = service.list('seed-prof-1')
    const tm = listed.find((p) => p.id === TABLE_MEMORY)
    expect(tm).toBeDefined()
    expect(tm!.builtin).toBe(true)

    // Idempotent: a second seed does not duplicate the row.
    service.seedBuiltinPacks('seed-prof-1')
    expect(service.list('seed-prof-1').filter((p) => p.id === TABLE_MEMORY)).toHaveLength(1)
  })

  it('the seeded pack ships gate CLOSED by default (no activation row → closed)', () => {
    service.seedBuiltinPacks('seed-prof-2')
    // No activation row seeded → resolveGate default is closed (packs are opt-in).
    expect(service.getGate(TABLE_MEMORY, 'any-world', 'any-chat')).toBe(false)
  })

  it('the seeded builtin pack is UNINSTALLABLE (uninstall refused + logged)', () => {
    service.seedBuiltinPacks('seed-prof-3')
    expect(service.uninstall('seed-prof-3', TABLE_MEMORY)).toEqual({ ok: false, code: 'builtin' })
    expect(service.list('seed-prof-3').some((p) => p.id === TABLE_MEMORY)).toBe(true)
    expect(mockLog.log).toHaveBeenCalled()
  })

  it('list() lazily seeds even without an explicit seedBuiltinPacks call', () => {
    // A fresh profile that was never explicitly seeded — list() must surface the builtin.
    expect(service.list('seed-prof-4').some((p) => p.id === TABLE_MEMORY)).toBe(true)
  })
})

describe('fork (ADR 0006; WP3.6a)', () => {
  it('nextForkId: first free <id>.fork-<n>', () => {
    expect(service.nextForkId('p1', new Set()).id).toBe('p1.fork-1')
    expect(service.nextForkId('p1', new Set(['p1.fork-1'])).id).toBe('p1.fork-2')
    expect(service.nextForkId('p1', new Set(['p1.fork-1', 'p1.fork-2'])).n).toBe(3)
  })

  it('deriveForkManifest records structured locale-neutral fork provenance', () => {
    const m = service.deriveForkManifest({ name: 'Memory Keeper', creator: 'me' }, 1)
    expect(m.fork).toEqual({ base: 'Memory Keeper', n: 1 })
    expect(m.creator).toBe('me')
  })

  it('deriveForkManifest flattens the base when forking a fork', () => {
    // Source is itself a fork (fork.base = the root name) → the new fork keeps the ROOT base.
    const m = service.deriveForkManifest({ name: 'Memory Keeper (fork 1)', fork: { base: 'Memory Keeper', n: 1 } }, 2)
    expect(m.fork).toEqual({ base: 'Memory Keeper', n: 2 })
  })

  it('records lineage, repoints the editing world, leaves other worlds + the source install untouched, carries overrides', () => {
    state.packs = [pack({ id: 'p1', builtin: true })]
    // p1 gated open in the editing world w1 (world row + a chat exception) AND in another world w2.
    state.activation = [
      { packId: 'p1', worldId: 'w1', chatId: null, gateOpen: true, denial: [] },
      { packId: 'p1', worldId: 'w1', chatId: 'c1', gateOpen: false, denial: [] },
      { packId: 'p1', worldId: 'w2', chatId: null, gateOpen: true, denial: [] }
    ]
    state.overrides = [{ packId: 'p1', scope: 'world:w1', settingId: 'tone', value: 'warm' }]

    const r = service.forkPack('prof', 'p1', 'w1')
    expect(r.ok).toBe(true)
    const forkId = r.pack!.id
    expect(forkId).toBe('p1.fork-1')

    // Lineage recorded, non-builtin.
    const fork = state.packs.find((p) => p.id === forkId)!
    expect(fork.upstreamId).toBe('p1')
    expect(fork.builtin).toBe(false)

    // World w1 repointed to the fork (both the world row and the chat exception copied), source's w1
    // rows removed; w2 (other world) untouched on the SOURCE.
    const forkW1 = state.activation.filter((a) => a.packId === forkId && a.worldId === 'w1')
    expect(forkW1).toHaveLength(2)
    expect(state.activation.some((a) => a.packId === 'p1' && a.worldId === 'w1')).toBe(false)
    expect(state.activation.some((a) => a.packId === 'p1' && a.worldId === 'w2' && a.gateOpen)).toBe(true)

    // Overrides carried over to the fork.
    expect(state.overrides.some((o) => o.packId === forkId && o.settingId === 'tone' && o.value === 'warm')).toBe(true)

    // The builtin source stays installed.
    expect(state.packs.some((p) => p.id === 'p1')).toBe(true)
  })

  it('uses editedFragment when provided, else the source fragment', () => {
    state.packs = [pack({ id: 'p1' })]
    const edited = { ...pack().fragment, name: 'Edited' } as WorkflowDoc
    service.forkPack('prof', 'p1', 'w1', edited)
    const fork = state.packs.find((p) => p.id === 'p1.fork-1')!
    expect(fork.fragment.name).toBe('Edited')

    service.forkPack('prof', 'p1', 'w1')
    const fork2 = state.packs.find((p) => p.id === 'p1.fork-2')!
    expect(fork2.fragment.name).toBe('F') // the source fragment's name
  })

  it('forking an unknown pack fails', () => {
    expect(service.forkPack('prof', 'nope', 'w1').ok).toBe(false)
  })
})

describe('fragment write-through (updatePackFragment; ADR 0006; WP3.6b)', () => {
  // A fully-valid fragment (text.template REQUIRES a `template` config — validateWorkflowDoc runs the
  // per-node config schema). pack()'s fragment omits it, so build the valid one explicitly here.
  const validFragment = (): WorkflowDoc =>
    ({
      id: 'frag',
      name: 'F',
      version: 1,
      schemaVersion: 1,
      kind: 'fragment',
      nodes: [{ id: 'blk', type: 'text.template', config: { template: 'x' } }],
      edges: [],
      attachments: [
        { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }
      ]
    }) as WorkflowDoc

  it('replaces a non-builtin pack fragment and round-trips (returns refreshed summary)', () => {
    state.packs = [pack({ id: 'fk', builtin: false, fragment: validFragment() })]
    const edited = { ...validFragment(), name: 'Edited-Fragment' } as WorkflowDoc
    const r = service.updatePackFragment('prof', 'fk', edited)
    expect(r.ok).toBe(true)
    // The stored fragment is replaced (write went through the wrapper).
    expect(state.packs.find((p) => p.id === 'fk')!.fragment.name).toBe('Edited-Fragment')
    expect(store.updatePackFragmentRow).toHaveBeenCalled()
  })

  it('REFUSES a builtin pack (edit-via-fork only) with code builtin — no write', () => {
    state.packs = [pack({ id: 'bi', builtin: true })]
    const r = service.updatePackFragment('prof', 'bi', pack().fragment)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('builtin')
    expect(store.updatePackFragmentRow).not.toHaveBeenCalled()
  })

  it('REFUSES an invalid fragment with code invalid + a detail message — no write', () => {
    state.packs = [pack({ id: 'fk' })]
    // A fragment with NO attachments fails the fragment-kind rule (validateWorkflow: ≥1 attachment).
    const invalid = { ...pack().fragment, attachments: [] } as unknown as WorkflowDoc
    const r = service.updatePackFragment('prof', 'fk', invalid)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('invalid')
    expect(typeof r.error).toBe('string')
    expect(store.updatePackFragmentRow).not.toHaveBeenCalled()
  })

  it('REFUSES an unknown pack with code not-found', () => {
    const r = service.updatePackFragment('prof', 'nope', pack().fragment)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('not-found')
  })

  it('getPackFragment returns the source fragment, or null when not installed', () => {
    state.packs = [pack({ id: 'fk' })]
    expect(service.getPackFragment('prof', 'fk')?.name).toBe('F')
    expect(service.getPackFragment('prof', 'nope')).toBeNull()
  })
})

describe('getEffectiveGraph projection (WP3.6a)', () => {
  beforeEach(() => setEnabledFragmentsProvider(service.enabledFragmentsFor))

  it('returns the doc + warnings + per-pack grouping; a spliced pack is NOT triggerOnly', () => {
    // pack() has a prompt-assembly rejoin on node `blk` — it splices (nodeIds non-empty).
    state.packs = [pack({ id: 'p1' })]
    state.activation = [{ packId: 'p1', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]

    const eff = service.getEffectiveGraph('prof', 'c1')
    expect(eff.packs).toHaveLength(1)
    const p = eff.packs[0]
    expect(p.packId).toBe('p1')
    expect(p.gateOpen).toBe(true)
    expect(p.nodeIds).toContain('pack:p1:blk')
    expect(p.triggerOnly).toBe(false)
  })

  it('a gate-open pack that splices NO checkpoint attachment is triggerOnly (present-but-detached)', () => {
    // A trigger-only fragment: its ONLY attachment is a trigger. GROUNDED against compose.ts:250-253:
    // with NO entry attachments, compose keeps ALL the fragment's nodes (nodeIds non-empty), but wires
    // none of them to the narrator — no entry/rejoin edge. So triggerOnly = (no spliced attachment),
    // NOT (empty nodeIds). The node is present-but-detached; the renderer draws it as a detached region.
    const triggerOnlyPack = pack({
      id: 'to',
      fragment: {
        id: 'tof',
        name: 'TO',
        version: 1,
        schemaVersion: 1,
        kind: 'fragment',
        nodes: [{ id: 'n', type: 'text.template' }],
        edges: [],
        attachments: [
          { kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }
        ]
      } as WorkflowDoc
    })
    state.packs = [triggerOnlyPack]
    state.activation = [{ packId: 'to', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]

    const eff = service.getEffectiveGraph('prof', 'c1')
    expect(eff.packs).toHaveLength(1)
    expect(eff.packs[0].triggerOnly).toBe(true)
    // The node IS present in the composed doc (present-but-detached) — the grounded truth.
    expect(eff.packs[0].nodeIds).toContain('pack:to:n')
    expect(eff.doc.nodes.some((n) => n.id === 'pack:to:n')).toBe(true)
  })

  it('no open packs → empty packs list, doc is the narrator', () => {
    state.packs = []
    const eff = service.getEffectiveGraph('prof', 'c1')
    expect(eff.packs).toEqual([])
  })
})

describe('provider registration (WP1.3 seam integration)', () => {
  // Module init registered enabledFragmentsFor on the seam, but other suites' afterEach reset it to
  // the default. Re-register the service's real provider so we exercise the actual init wiring.
  beforeEach(() => setEnabledFragmentsProvider(service.enabledFragmentsFor))

  it('after service init, resolveEffectiveDoc composes an enabled pack fragment', () => {
    // getChat mock returns world w1; one pack, gated open for w1.
    state.packs = [pack()]
    state.activation = [{ packId: 'p1', worldId: 'w1', chatId: null, gateOpen: true, denial: [] }]

    const eff = resolveEffectiveDoc('prof', 'c1')
    expect(eff.id).toBe(BUILTIN_WORKFLOW_ID)
    // The pack's node was spliced under the pack prefix — proof the provider is live.
    expect(eff.doc.nodes.some((n) => n.id === 'pack:p1:blk')).toBe(true)
    expect(eff.warnings).toEqual([])
  })

  it('with no open packs, resolveEffectiveDoc returns the narrator unchanged (zero-packs identity)', () => {
    state.packs = []
    const eff = resolveEffectiveDoc('prof', 'c1')
    expect(eff.doc.nodes.every((n) => !n.id.startsWith('pack:'))).toBe(true)
  })
})
