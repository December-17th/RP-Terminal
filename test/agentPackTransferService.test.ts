import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { WorkflowDoc } from '../src/shared/workflow/types'
import { serializePackEnvelope, PackEnvelope } from '../src/shared/workflow/packEnvelope'
import { AgentPackRecord, ActivationRow, OverrideRow } from '../src/main/services/agentPackStore'
import { TableTemplate } from '../src/main/types/tableTemplate'

// agentPackTransferService (WP4.2) is the main-side export/import layer over the SHARED envelope.
// It touches: the SQLite store (mocked with in-memory fakes, like agentPackService.test), the
// table-template service (mocked — we assert bundling calls without real files), electron's app
// (mocked getVersion), logService (silenced), and the REAL fs for the file paths (real temp files,
// like tableTemplateService.test). The capability derivation + registry are REAL (the point of the
// soundness check). agentPackService.install is REAL and drives the mocked store.

// ── mocks ─────────────────────────────────────────────────────────────────────────────────────────

const { encodeScope: realEncodeScope, resolveGate: realResolveGate } = await vi.importActual<
  typeof import('../src/main/services/agentPackStore')
>('../src/main/services/agentPackStore')

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
vi.mock('../src/main/services/agentPackStore', () => store)

const mockChatService = vi.hoisted(() => ({
  getChat: vi.fn<() => { character_id: string } | null>(() => null),
  getChatWorkflowId: vi.fn<() => string | null>(() => null)
}))
vi.mock('../src/main/services/chatService', () => mockChatService)

const mockTemplates = vi.hoisted(() => ({
  listTableTemplates: vi.fn<() => { id: string; name: string; tableCount: number }[]>(() => []),
  saveTableTemplate: vi.fn<(profileId: string, t: TableTemplate) => string>(() => 'tpl-id')
}))
vi.mock('../src/main/services/tableTemplateService', () => mockTemplates)

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)

// electron's `app.getVersion()` — the minRptVersion gate reads it (via transfer.appVersion()).
const mockApp = vi.hoisted(() => ({ getVersion: vi.fn(() => '1.0.0') }))
vi.mock('electron', () => ({ app: mockApp }))

// workflowService is REAL (importing agentPackService registers its provider seam). Reset after each.
import { setEnabledFragmentsProvider } from '../src/main/services/workflowService'
import * as transfer from '../src/main/services/agentPackTransferService'

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

// A minimal valid kind:'fragment' doc: one capability-mapped node + one attachment (structural gate
// requires ≥1). All node types are BUILTIN so the capability report surfaces no unknown types.
const goodFragment = (): WorkflowDoc => ({
  id: 'frag',
  name: 'Mem Fragment',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes: [
    { id: 'read', type: 'table.read' },
    { id: 'apply', type: 'table.apply' }
  ],
  edges: [],
  attachments: [
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'read', port: 'gen' } }
  ]
})

const pack = (over: Partial<AgentPackRecord> = {}): AgentPackRecord => ({
  id: 'pack.memory',
  version: 2,
  upstreamId: 'builtin.table-memory',
  upstreamVersion: null,
  builtin: false,
  manifest: { name: 'Memory Keeper', creator: 'someone', description: 'keeps memory' },
  fragment: goodFragment(),
  ...over
})

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-transfer-'))
const tmpFiles: string[] = []
const writeTmp = (text: string): string => {
  const p = path.join(tmpDir, `f-${randomUUID()}.rptagent`)
  fs.writeFileSync(p, text, 'utf-8')
  tmpFiles.push(p)
  return p
}
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

beforeEach(() => {
  state.packs = []
  state.activation = []
  state.overrides = []
  Object.values(store).forEach((fn) => fn.mockReset())
  mockLog.log.mockReset()
  mockApp.getVersion.mockReset().mockReturnValue('1.0.0')
  mockTemplates.listTableTemplates.mockReset().mockReturnValue([])
  mockTemplates.saveTableTemplate.mockReset().mockImplementation(() => `tpl-${randomUUID()}`)

  store.encodeScope.mockImplementation(realEncodeScope)
  store.resolveGate.mockImplementation(realResolveGate)
  store.listPackRecords.mockImplementation(() => state.packs)
  // WP4.6: getPackIdentity probes the EXACT (id, version); getPackRecord takes an optional version
  // (else the highest); listPackVersions returns the id's version set.
  store.getPackIdentity.mockImplementation((_p, id, version) => {
    const found = state.packs.find((x) => x.id === id && x.version === version)
    return found ? { id: found.id, version: found.version } : null
  })
  store.getPackRecord.mockImplementation((_p, id, version) => {
    const matches = state.packs.filter((x) => x.id === id && (version == null || x.version === version))
    if (matches.length === 0) return null
    return [...matches].sort((a, b) => b.version - a.version)[0]
  })
  store.listPackVersions.mockImplementation((_p, id) =>
    state.packs.filter((x) => x.id === id).map((x) => x.version).sort((a, b) => a - b)
  )
  store.insertPack.mockImplementation((_p, x) => state.packs.push(x))
  store.packToSummary.mockImplementation((x) => ({
    id: x.id,
    version: x.version,
    upstreamId: x.upstreamId,
    upstreamVersion: x.upstreamVersion,
    builtin: x.builtin,
    manifest: x.manifest,
    attachments: x.fragment.attachments ?? [],
    capabilities: [],
    versions: [x.version]
  }))
  store.listActivationRows.mockImplementation((id) => state.activation.filter((r) => r.packId === id))
  store.listOverrideRows.mockImplementation((id) => state.overrides.filter((r) => r.packId === id))
})

afterEach(() => setEnabledFragmentsProvider())

// ── EXPORT ────────────────────────────────────────────────────────────────────────────────────────

describe('export', () => {
  it('refuses a builtin pack (builtin-not-exportable)', () => {
    state.packs = [pack({ builtin: true })]
    const preview = transfer.previewAgentPackExport('prof', 'pack.memory')
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.error.code).toBe('builtin-not-exportable')

    const written = transfer.writeAgentPackExport('prof', 'pack.memory', writeTmp(''))
    expect(written.ok).toBe(false)
  })

  it('refuses a not-installed pack (not-installed)', () => {
    const preview = transfer.previewAgentPackExport('prof', 'nope')
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.error.code).toBe('not-installed')
  })

  it('exports a FORK of a builtin (fork is a non-builtin row → exportable)', () => {
    state.packs = [pack()] // upstreamId set (a fork), builtin:false
    const preview = transfer.previewAgentPackExport('prof', 'pack.memory')
    expect(preview.ok).toBe(true)
    if (preview.ok) {
      expect(preview.preview.envelopeMeta.name).toBe('Memory Keeper')
      expect(preview.preview.envelopeMeta.version).toBe(2)
      expect(preview.preview.noTemplatesBundled).toBe(true)
      expect(preview.preview.bundledTemplateNames).toEqual([])
      // table.read/table.apply → reads-tables + writes-tables surface in the report.
      expect(preview.preview.capabilityReport.capabilities).toContain('writes-tables')
      expect(preview.preview.capabilityReport.unknownNodeTypes).toEqual([])
    }
  })

  it('writeAgentPackExport writes parseable UTF-8; the filename is <id>-v<version>.rptagent', () => {
    state.packs = [pack()]
    const p = path.join(tmpDir, 'out.rptagent')
    tmpFiles.push(p)
    const res = transfer.writeAgentPackExport('prof', 'pack.memory', p)
    expect(res.ok).toBe(true)
    const text = fs.readFileSync(p, 'utf-8')
    expect(JSON.parse(text).kind).toBe('rptagent')
    expect(transfer.exportFileName('pack.memory', 2)).toBe('pack.memory-v2.rptagent')
  })

  it('surfaces subgraph.call presence as a warning in the export preview', () => {
    const frag = goodFragment()
    frag.nodes.push({ id: 'sub', type: 'subgraph.call' })
    state.packs = [pack({ fragment: frag })]
    const preview = transfer.previewAgentPackExport('prof', 'pack.memory')
    expect(preview.ok).toBe(true)
    if (preview.ok) expect(preview.preview.warnings.some((w) => w.includes('sub-graph'))).toBe(true)
  })
})

// ── IMPORT: inspect → confirm ─────────────────────────────────────────────────────────────────────

/** Serialize a valid envelope for a pack record (round-trips through the shared serializer). */
const envelopeText = (over: Partial<AgentPackRecord> = {}, extra: Record<string, unknown> = {}): string => {
  const p = pack(over)
  const text = serializePackEnvelope({ id: p.id, version: p.version, manifest: p.manifest, fragment: p.fragment })
  // Splice any extra top-level/pack fields (e.g. minRptVersion, bundledTemplates) for the edge tests.
  if (Object.keys(extra).length === 0) return text
  const obj = JSON.parse(text)
  Object.assign(obj, extra)
  return JSON.stringify(obj)
}

describe('import — inspect', () => {
  it('inspects a clean file: dedupe "new", no blockers, a token', () => {
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText()), '1.0.0')
    expect(report.parseError).toBeUndefined()
    expect(report.dedupe).toBe('new')
    expect(report.blockers).toEqual([])
    expect(report.token).toBeDefined()
    expect(report.envelopeMeta?.id).toBe('pack.memory')
    expect(report.capabilityReport?.capabilities).toContain('reads-tables')
  })

  it('reports a parse failure with no token (unreadable file)', () => {
    const report = transfer.inspectAgentPackFile('prof', writeTmp('not json'), '1.0.0')
    expect(report.parseError).toBeDefined()
    expect(report.token).toBeUndefined()
  })

  it('dedupe: same id+version already installed → "already-installed", no blocker', () => {
    state.packs = [pack()] // id pack.memory, version 2
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText()), '1.0.0')
    expect(report.dedupe).toBe('already-installed')
    expect(report.blockers).toEqual([])
  })

  // WP4.6 (REPLACES the old version-conflict blocker test): same id, DIFFERENT version installed now
  // reports dedupe 'new-version' with NO blocker — it installs ALONGSIDE (ADR 0008 version coexistence).
  it('new-version: same id DIFFERENT version installed → dedupe "new-version", NO blocker', () => {
    state.packs = [pack({ version: 5 })] // installed v5, file is v2
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText()), '1.0.0')
    expect(report.dedupe).toBe('new-version')
    expect(report.blockers.some((b) => b.code === 'version-conflict')).toBe(false)
    expect(report.blockers).toEqual([]) // installable alongside
  })

  it('unknown-node-types: a fake node type in the fragment → blocker listing it', () => {
    const frag = goodFragment()
    // A type NEITHER capability-mapped NOR registered — surfaces as unknown (ADR 0007 soundness).
    frag.nodes.push({ id: 'x', type: 'made.up.future.node' })
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText({ fragment: frag })), '1.0.0')
    const blocker = report.blockers.find((b) => b.code === 'unknown-node-types')
    expect(blocker).toBeDefined()
    if (blocker?.code === 'unknown-node-types') expect(blocker.nodeTypes).toContain('made.up.future.node')
  })

  it('version-too-old: minRptVersion newer than app → blocker', () => {
    const p = pack()
    const obj = JSON.parse(
      serializePackEnvelope({ id: p.id, version: p.version, manifest: p.manifest, fragment: p.fragment })
    )
    obj.pack.minRptVersion = '2.0.0'
    const report = transfer.inspectAgentPackFile('prof', writeTmp(JSON.stringify(obj)), '1.0.0')
    const blocker = report.blockers.find((b) => b.code === 'version-too-old')
    expect(blocker).toBeDefined()
    if (blocker?.code === 'version-too-old') expect(blocker.minRptVersion).toBe('2.0.0')
  })

  it('surfaces subgraph.call presence as a warning at inspect', () => {
    const frag = goodFragment()
    frag.nodes.push({ id: 'sub', type: 'subgraph.loop' })
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText({ fragment: frag })), '1.0.0')
    expect(report.warnings.some((w) => w.includes('sub-graph'))).toBe(true)
  })

  it('bundled template collision: existing name → will-duplicate; fresh name → will-install', () => {
    mockTemplates.listTableTemplates.mockReturnValue([{ id: 't1', name: 'Existing', tableCount: 1 }])
    const p = pack()
    const obj = JSON.parse(serializePackEnvelope({ id: p.id, version: p.version, manifest: p.manifest, fragment: p.fragment }))
    obj.bundledTemplates = [
      { name: 'Existing', tables: [] },
      { name: 'Brand New', tables: [] }
    ]
    const report = transfer.inspectAgentPackFile('prof', writeTmp(JSON.stringify(obj)), '1.0.0')
    expect(report.bundledTemplatePlans).toEqual([
      { name: 'Existing', outcome: 'will-duplicate' },
      { name: 'Brand New', outcome: 'will-install' }
    ])
  })
})

describe('import — confirm', () => {
  it('confirm installs a clean pack (gate CLOSED — no activation row written)', () => {
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText()), '1.0.0')
    const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.installed).toBe('installed')
      expect(res.pack.id).toBe('pack.memory')
    }
    expect(state.packs).toHaveLength(1)
    expect(state.packs[0].builtin).toBe(false)
    expect(state.activation).toHaveLength(0) // ADR 0005: install ≠ activate
  })

  // WP4.6: minRptVersion now PERSISTS on the manifest, so it round-trips export → import → re-export.
  it('minRptVersion round-trips: export writes it, import stores it, a re-export re-advertises it', () => {
    // A stored pack whose manifest declares a minRptVersion the current app satisfies (1.0.0 >= 0.5.0).
    state.packs = [pack({ manifest: { name: 'Memory Keeper', minRptVersion: '0.5.0' } })]
    const p1 = path.join(tmpDir, 'minrpt.rptagent')
    tmpFiles.push(p1)
    expect(transfer.writeAgentPackExport('prof', 'pack.memory', p1).ok).toBe(true)
    // The exported file advertises the minimum.
    expect(JSON.parse(fs.readFileSync(p1, 'utf-8')).pack.minRptVersion).toBe('0.5.0')

    // Import into a clean store — the minimum is stored on the installed manifest.
    state.packs = []
    const report = transfer.inspectAgentPackFile('prof2', p1, '1.0.0')
    expect(report.envelopeMeta?.minRptVersion).toBe('0.5.0')
    expect(report.blockers).toEqual([]) // app is new enough
    expect(transfer.confirmAgentPackImport(report.token!, '1.0.0').ok).toBe(true)
    expect(state.packs[0].manifest.minRptVersion).toBe('0.5.0')

    // A re-export of the just-imported pack re-advertises it (proves persistence, not a hand-built file).
    const p2 = path.join(tmpDir, 'minrpt-reexport.rptagent')
    tmpFiles.push(p2)
    expect(transfer.writeAgentPackExport('prof2', 'pack.memory', p2).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(p2, 'utf-8')).pack.minRptVersion).toBe('0.5.0')
  })

  it('round-trips: export a fork → inspect → confirm on a clean store', () => {
    // Export the fork to a file.
    state.packs = [pack()]
    const p = path.join(tmpDir, 'roundtrip.rptagent')
    tmpFiles.push(p)
    expect(transfer.writeAgentPackExport('prof', 'pack.memory', p).ok).toBe(true)
    // Fresh store, import it.
    state.packs = []
    const report = transfer.inspectAgentPackFile('prof2', p, '1.0.0')
    expect(report.blockers).toEqual([])
    const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(res.ok).toBe(true)
    expect(state.packs.map((x) => x.id)).toContain('pack.memory')
  })

  it('confirm dedupe: same id+version already installed → already-installed no-op', () => {
    const text = envelopeText()
    const report = transfer.inspectAgentPackFile('prof', writeTmp(text), '1.0.0')
    state.packs = [pack()] // becomes installed between inspect and confirm
    const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.installed).toBe('already-installed')
    expect(state.packs).toHaveLength(1)
  })

  // WP4.6 (REPLACES "confirm REFUSES a version-conflict"): a different version now INSTALLS ALONGSIDE
  // at confirm — two coexisting library rows, the gate untouched (ADR 0005 install ≠ activate).
  it('confirm INSTALLS a different version ALONGSIDE the installed one (no refusal)', () => {
    state.packs = [pack({ version: 5 })] // installed v5; the file is v2
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText()), '1.0.0')
    expect(report.dedupe).toBe('new-version')
    const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.installed).toBe('installed')
    // Both versions now coexist in the library.
    expect(state.packs.filter((p) => p.id === 'pack.memory').map((p) => p.version).sort()).toEqual([2, 5])
    expect(state.activation).toHaveLength(0) // gate stays closed
  })

  it('confirm REFUSES unknown-node-types', () => {
    const frag = goodFragment()
    frag.nodes.push({ id: 'x', type: 'made.up.future.node' })
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText({ fragment: frag })), '1.0.0')
    const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(res.ok).toBe(false)
    if (!res.ok && res.code === 'blocked')
      expect(res.blockers.some((b) => b.code === 'unknown-node-types')).toBe(true)
    expect(state.packs).toHaveLength(0)
  })

  it('confirm installs bundled templates (saveTableTemplate called; result lists them)', () => {
    mockTemplates.saveTableTemplate.mockReturnValue('tpl-42')
    const p = pack()
    const obj = JSON.parse(serializePackEnvelope({ id: p.id, version: p.version, manifest: p.manifest, fragment: p.fragment }))
    // A valid native TableTemplate (a single table with the required uid/sqlName/ddl fields).
    obj.bundledTemplates = [
      { name: 'Bundled', sourceFormat: 'native', tables: [{ uid: 'u1', sqlName: 'notes', ddl: 'CREATE TABLE notes(id)' }] }
    ]
    const report = transfer.inspectAgentPackFile('prof', writeTmp(JSON.stringify(obj)), '1.0.0')
    const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.installedTemplates).toEqual([{ name: 'Bundled', id: 'tpl-42' }])
    }
    expect(mockTemplates.saveTableTemplate).toHaveBeenCalledTimes(1)
  })

  it('a malformed bundled template is skipped + logged, never blocks the pack install', () => {
    const p = pack()
    const obj = JSON.parse(serializePackEnvelope({ id: p.id, version: p.version, manifest: p.manifest, fragment: p.fragment }))
    // Passes the envelope's structural subset (name + tables[] with uid/sqlName/ddl strings, extras
    // ride via passthrough) but FAILS the full TableTemplateSchema: updateFrequency must be a positive
    // int (TableDefSchema `.int().positive()`), and -5 is neither. So the envelope accepts the file but
    // saveTableTemplate's `TableTemplateSchema.parse` rejects it → the template is skipped + logged.
    obj.bundledTemplates = [
      {
        name: 'Bad',
        tables: [{ uid: 'u', sqlName: 's', ddl: 'CREATE TABLE s(x)', updateFrequency: -5 }]
      }
    ]
    const report = transfer.inspectAgentPackFile('prof', writeTmp(JSON.stringify(obj)), '1.0.0')
    expect(report.parseError).toBeUndefined() // envelope accepts it
    const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.installedTemplates).toEqual([]) // skipped
    expect(state.packs).toHaveLength(1) // pack still installed
    expect(mockLog.log).toHaveBeenCalled()
  })
})

// ── cancel + TTL ─────────────────────────────────────────────────────────────────────────────────

describe('cancel + TTL cleanup', () => {
  it('cancel drops the token: a subsequent confirm is expired', () => {
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText()), '1.0.0')
    transfer.cancelAgentPackImport(report.token!)
    const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('expired')
  })

  it('confirm consumes the token (single-use): a second confirm is expired', () => {
    const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText()), '1.0.0')
    expect(transfer.confirmAgentPackImport(report.token!, '1.0.0').ok).toBe(true)
    const again = transfer.confirmAgentPackImport(report.token!, '1.0.0')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('expired')
  })

  it('an expired token is swept: confirm after TTL is expired', () => {
    vi.useFakeTimers()
    try {
      const report = transfer.inspectAgentPackFile('prof', writeTmp(envelopeText()), '1.0.0')
      vi.advanceTimersByTime(transfer.IMPORT_TOKEN_TTL_MS + 1)
      transfer.sweepExpiredImports()
      const res = transfer.confirmAgentPackImport(report.token!, '1.0.0')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── version comparison unit ────────────────────────────────────────────────────────────────────

describe('isVersionTooOld', () => {
  it('required newer than app → true; equal/older → false', () => {
    expect(transfer.isVersionTooOld('2.0.0', '1.0.0')).toBe(true)
    expect(transfer.isVersionTooOld('1.1.0', '1.0.0')).toBe(true)
    expect(transfer.isVersionTooOld('1.0.0', '1.0.0')).toBe(false)
    expect(transfer.isVersionTooOld('0.9.0', '1.0.0')).toBe(false)
  })
})
