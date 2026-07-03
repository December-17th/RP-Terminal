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
  layerOverrides: realLayerOverrides
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
  layerOverrides: vi.fn()
}))

vi.mock('../src/main/services/agentPackStore', () => store)

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

  // Wire the mocked store to the in-memory state + real pure helpers.
  store.encodeScope.mockImplementation(realEncodeScope)
  store.resolveGate.mockImplementation(realResolveGate)
  store.layerOverrides.mockImplementation(realLayerOverrides)
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

  it('uninstall removes a non-builtin pack', () => {
    service.install('prof', pack())
    expect(service.uninstall('prof', 'p1')).toBe(true)
    expect(state.packs).toHaveLength(0)
  })

  it('uninstall REFUSES a builtin pack (uninstallable) and logs', () => {
    service.install('prof', pack({ builtin: true }))
    expect(service.uninstall('prof', 'p1')).toBe(false)
    expect(state.packs).toHaveLength(1)
    expect(mockLog.log).toHaveBeenCalled()
  })

  it('uninstall of an unknown pack returns false', () => {
    expect(service.uninstall('prof', 'nope')).toBe(false)
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
    expect(service.uninstall('seed-prof-3', TABLE_MEMORY)).toBe(false)
    expect(service.list('seed-prof-3').some((p) => p.id === TABLE_MEMORY)).toBe(true)
    expect(mockLog.log).toHaveBeenCalled()
  })

  it('list() lazily seeds even without an explicit seedBuiltinPacks call', () => {
    // A fresh profile that was never explicitly seeded — list() must surface the builtin.
    expect(service.list('seed-prof-4').some((p) => p.id === TABLE_MEMORY)).toBe(true)
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
