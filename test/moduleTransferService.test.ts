import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { WorkflowDoc } from '../src/shared/workflow/types'
import {
  serializeModuleEnvelope,
  parseModuleEnvelope,
  type ModulePayload
} from '../src/shared/workflow/moduleEnvelope'
import { TableTemplate } from '../src/main/types/tableTemplate'

// moduleTransferService (one-canvas rebuild WP6.5) is the main-side export/import layer over the SHARED
// moduleEnvelope. Like agentPackTransferService.test it mocks the table-template service (assert
// bundling without real files) + logService, uses the REAL fs for temp files, and the REAL builtin
// registry + capability derivation (the point of the unknown-type soundness check). Dialog-free core.

const mockTemplates = vi.hoisted(() => ({
  listTableTemplates: vi.fn<() => { id: string; name: string; tableCount: number }[]>(() => []),
  saveTableTemplate: vi.fn<(profileId: string, t: TableTemplate) => string>(() => 'tpl-id')
}))
vi.mock('../src/main/services/tableTemplateService', () => mockTemplates)

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)

import * as transfer from '../src/main/services/moduleTransferService'

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

/** A doc with a group over 3 members and a boundary edge into a 4th (ungrouped) node — so the build
 *  can be asserted to DROP the boundary edge and keep only internal ones. All node types are BUILTIN. */
const docWithGroup = (): WorkflowDoc => ({
  id: 'doc-1',
  name: 'Doc',
  version: 1,
  schemaVersion: 1,
  nodes: [
    { id: 'ctx', type: 'input.context', position: { x: 0, y: 0 } },
    { id: 'read', type: 'table.read', position: { x: 200, y: 0 } },
    { id: 'apply', type: 'table.apply', position: { x: 400, y: 0 } },
    { id: 'outside', type: 'util.log', position: { x: 600, y: 0 } }
  ],
  edges: [
    { from: { node: 'read', port: 'gen' }, to: { node: 'apply', port: 'gen' } }, // internal
    { from: { node: 'ctx', port: 'gen' }, to: { node: 'read', port: 'gen' } }, // internal (ctx∈group)
    { from: { node: 'apply', port: 'gen' }, to: { node: 'outside', port: 'gen' } } // boundary → drop
  ],
  groups: [
    {
      id: 'group-1',
      name: 'Memory Module',
      nodeIds: ['ctx', 'read', 'apply'],
      exposed: [{ node: 'apply', path: 'every', label: 'Update every' }]
    }
  ]
})

const goodTemplate: TableTemplate = {
  name: 'Poem Tables',
  sourceFormat: 'native',
  tables: [
    {
      uid: 'u1',
      displayName: 'Log',
      sqlName: 'log',
      ddl: 'CREATE TABLE log (id INTEGER)',
      headers: [],
      initialRows: [],
      note: '',
      initNode: '',
      insertNode: '',
      updateNode: '',
      deleteNode: '',
      updateFrequency: 1,
      exportConfig: {
        enabled: false,
        splitByRow: false,
        entryName: '',
        entryType: 'constant',
        keywords: '',
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexEntryName: '',
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        extraIndexInjectionTemplate: '',
        entryPlacement: { position: 'at_depth_as_system', depth: 0, order: 0 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 0, order: 0 },
        fixedEntryPlacement: { position: 'at_depth_as_system', depth: 0, order: 0 },
        fixedIndexPlacement: { position: 'at_depth_as_system', depth: 0, order: 0 }
      }
    }
  ]
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-module-'))
const writeTmp = (text: string): string => {
  const p = path.join(tmpDir, `f-${randomUUID()}.rptmodule`)
  fs.writeFileSync(p, text, 'utf-8')
  return p
}
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

beforeEach(() => {
  mockTemplates.listTableTemplates.mockReset().mockReturnValue([])
  mockTemplates.saveTableTemplate.mockReset().mockImplementation(() => `tpl-${randomUUID()}`)
  mockLog.log.mockReset()
})

// ── build (export core) ───────────────────────────────────────────────────────────────────────────

describe('buildModuleEnvelope', () => {
  it('collects members + INTERNAL edges only (drops the boundary edge) + exposed + name', () => {
    const built = transfer.buildModuleEnvelope(docWithGroup(), 'group-1')
    expect(built).not.toBeNull()
    const m = built!.module
    expect(m.name).toBe('Memory Module')
    expect(m.nodes.map((n) => n.id).sort()).toEqual(['apply', 'ctx', 'read'])
    // The apply→outside boundary edge is dropped; the two internal edges survive.
    expect(m.edges).toHaveLength(2)
    expect(m.edges.every((e) => ['ctx', 'read', 'apply'].includes(e.to.node))).toBe(true)
    expect(m.exposed).toEqual([{ node: 'apply', path: 'every', label: 'Update every' }])
    expect(built!.bundledTemplates).toBeUndefined()
  })

  it('returns null for an unknown group id', () => {
    expect(transfer.buildModuleEnvelope(docWithGroup(), 'nope')).toBeNull()
  })

  it('bundles the whole active template when includeTemplate is given', () => {
    const built = transfer.buildModuleEnvelope(docWithGroup(), 'group-1', {
      includeTemplate: goodTemplate
    })
    expect(built!.bundledTemplates).toEqual([goodTemplate])
  })

  it('round-trips through the shared envelope', () => {
    const built = transfer.buildModuleEnvelope(docWithGroup(), 'group-1')!
    const text = serializeModuleEnvelope(built.module, built.bundledTemplates)
    const parsed = parseModuleEnvelope(text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.module.nodes).toHaveLength(3)
  })

  it('carries the group’s `note` and round-trips it through the envelope (agent-memory-ux WP-A)', () => {
    const doc = docWithGroup()
    doc.groups![0].note = 'Needs a bound table template + an API preset.'
    const built = transfer.buildModuleEnvelope(doc, 'group-1')!
    expect(built.module.note).toBe('Needs a bound table template + an API preset.')
    const parsed = parseModuleEnvelope(serializeModuleEnvelope(built.module, built.bundledTemplates))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.module.note).toBe('Needs a bound table template + an API preset.')
  })

  it('omits `note` when the group has none (no stray field)', () => {
    const built = transfer.buildModuleEnvelope(docWithGroup(), 'group-1')!
    expect(built.module.note).toBeUndefined()
  })
})

// ── inspection core ─────────────────────────────────────────────────────────────────────────────

const goodModule = (): ModulePayload => ({
  name: 'Mem',
  nodes: [
    { id: 'read', type: 'table.read' },
    { id: 'apply', type: 'table.apply' }
  ],
  edges: [{ from: { node: 'read', port: 'gen' }, to: { node: 'apply', port: 'gen' } }]
})

const envelope = (module: ModulePayload, bundledTemplates?: TableTemplate[]) =>
  parseModuleEnvelope(serializeModuleEnvelope(module, bundledTemplates as never))

describe('buildModuleInspectionCore', () => {
  it('derives capabilities + meta; no blocker for all-known node types', () => {
    const parsed = envelope(goodModule())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const core = transfer.buildModuleInspectionCore('p', parsed.value, [])
    expect(core.meta?.nodeCount).toBe(2)
    expect(core.blockers).toHaveLength(0)
    expect(core.capabilityReport?.capabilities).toContain('reads-tables')
    expect(core.capabilityReport?.capabilities).toContain('writes-tables')
  })

  it('blocks a module with an unknown node type (soundness)', () => {
    const mod: ModulePayload = {
      name: 'X',
      nodes: [
        { id: 'a', type: 'table.read' },
        { id: 'b', type: 'totally.made.up' }
      ],
      edges: []
    }
    const parsed = envelope(mod)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const core = transfer.buildModuleInspectionCore('p', parsed.value, [])
    expect(core.blockers).toEqual([{ code: 'unknown-node-types', nodeTypes: ['totally.made.up'] }])
  })

  it('plans a bundled template as will-duplicate when a name collides', () => {
    mockTemplates.listTableTemplates.mockReturnValue([{ id: 'x', name: 'Poem Tables', tableCount: 1 }])
    const parsed = envelope(goodModule(), [goodTemplate])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const core = transfer.buildModuleInspectionCore('p', parsed.value, [])
    expect(core.templatePlans).toEqual([{ name: 'Poem Tables', outcome: 'will-duplicate' }])
  })
})

// ── envelope invariants (rejections) ───────────────────────────────────────────────────────────────

describe('moduleEnvelope rejections', () => {
  it('rejects an external edge', () => {
    const text = serializeModuleEnvelope({
      name: 'X',
      nodes: [
        { id: 'a', type: 'table.read' },
        { id: 'b', type: 'table.apply' }
      ],
      edges: [{ from: { node: 'a', port: 'gen' }, to: { node: 'ghost', port: 'gen' } }]
    })
    const parsed = parseModuleEnvelope(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.code).toBe('external-edge')
  })

  it('rejects an exposed setting that is not a member', () => {
    const text = serializeModuleEnvelope({
      name: 'X',
      nodes: [
        { id: 'a', type: 'table.read' },
        { id: 'b', type: 'table.apply' }
      ],
      edges: [],
      exposed: [{ node: 'ghost', path: 'p', label: 'L' }]
    })
    const parsed = parseModuleEnvelope(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.code).toBe('exposed-not-member')
  })

  it('rejects an empty module (<2 nodes)', () => {
    const text = serializeModuleEnvelope({ name: 'X', nodes: [{ id: 'a', type: 'table.read' }], edges: [] })
    const parsed = parseModuleEnvelope(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.code).toBe('empty-module')
  })
})

// ── inspect / confirm / cancel (token lifecycle) ────────────────────────────────────────────────

describe('inspect → confirm → cancel', () => {
  it('inspect mints a single-use token; confirm installs templates + returns the module', () => {
    const file = writeTmp(serializeModuleEnvelope(goodModule(), [goodTemplate] as never))
    const report = transfer.inspectModuleFile('p', file)
    expect(report.token).toBeTruthy()
    expect(report.blockers).toHaveLength(0)

    const result = transfer.confirmModuleImport(report.token!)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.module.nodes).toHaveLength(2)
      expect(result.installedTemplates).toHaveLength(1)
      expect(mockTemplates.saveTableTemplate).toHaveBeenCalledOnce()
    }
    // Single-use: a second confirm on the same token is expired.
    expect(transfer.confirmModuleImport(report.token!)).toEqual({ ok: false, code: 'expired' })
  })

  it('confirm refuses a blocked module (unknown node types)', () => {
    const mod: ModulePayload = {
      name: 'X',
      nodes: [
        { id: 'a', type: 'table.read' },
        { id: 'b', type: 'totally.made.up' }
      ],
      edges: []
    }
    const file = writeTmp(serializeModuleEnvelope(mod))
    const report = transfer.inspectModuleFile('p', file)
    expect(report.blockers).toHaveLength(1)
    const result = transfer.confirmModuleImport(report.token!)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('blocked')
  })

  it('cancel drops the token so confirm is expired', () => {
    const file = writeTmp(serializeModuleEnvelope(goodModule()))
    const report = transfer.inspectModuleFile('p', file)
    transfer.cancelModuleImport(report.token!)
    expect(transfer.confirmModuleImport(report.token!)).toEqual({ ok: false, code: 'expired' })
  })

  it('inspect returns a parseError (no token) for a garbage file', () => {
    const file = writeTmp('not json at all')
    const report = transfer.inspectModuleFile('p', file)
    expect(report.token).toBeUndefined()
    expect(report.parseError?.code).toBe('invalid-json')
  })
})
