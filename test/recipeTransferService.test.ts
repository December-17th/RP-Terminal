import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { WorkflowDoc } from '../src/shared/workflow/types'
import { AgentPackRecord, ActivationRow, OverrideRow } from '../src/main/services/agentPackStore'
import { TableTemplate } from '../src/main/types/tableTemplate'

// recipeTransferService (WP5.2) is the main-side recipe export/import layer over the SHARED recipe
// envelope. It mirrors agentPackTransferService.test's approach: the SQLite store is mocked with
// in-memory fakes (functional gate/override/activation state so real agentPackService.install/setGate/
// setActiveVersion/setOverride drive it), tableTemplateService is mocked (assert bundling), electron's
// app.getVersion + logService are mocked. workflowService is REAL — its file operations (selection
// sidecar, workflow docs) run against a TEMP getAppDir (storageService.getAppDir mocked). The
// capability derivation + node registry are REAL (the soundness point).

// ── temp data root (workflowService writes the selection sidecar + narrator docs here) ─────────────

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-recipe-data-'))
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<typeof import('../src/main/services/storageService')>(
    '../src/main/services/storageService'
  )
  return { ...actual, getAppDir: () => dataRoot }
})

// ── store mock (in-memory; functional so real agentPackService drives it) ──────────────────────────

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
  listPackRecords: vi.fn(),
  listPackVersions: vi.fn(),
  insertPack: vi.fn(),
  deletePackVersion: vi.fn(),
  deletePackVersionAgnosticRows: vi.fn(),
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
  getChatWorkflowId: vi.fn<() => string | null>(() => null),
  removeWorkflowIdFromChats: vi.fn()
}))
vi.mock('../src/main/services/chatService', () => mockChatService)

const mockTemplates = vi.hoisted(() => ({
  listTableTemplates: vi.fn<() => { id: string; name: string; tableCount: number }[]>(() => []),
  saveTableTemplate: vi.fn<(profileId: string, t: TableTemplate) => string>(() => 'tpl-id')
}))
vi.mock('../src/main/services/tableTemplateService', () => mockTemplates)

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)

const mockApp = vi.hoisted(() => ({ getVersion: vi.fn(() => '1.0.0') }))
vi.mock('electron', () => ({ app: mockApp }))

// workflowService is REAL (importing agentPackService registers its provider seam). Reset after each.
import {
  setEnabledFragmentsProvider,
  getSelection,
  getWorkflowById,
  createWorkflowFromDoc as realCreateWorkflow,
  setWorldWorkflow as realSetWorld
} from '../src/main/services/workflowService'
import * as recipe from '../src/main/services/recipeTransferService'

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

/** A minimal valid kind:'fragment' doc: capability-mapped builtin nodes + one attachment. */
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
    {
      kind: 'entry',
      checkpoint: 'context-ready',
      mode: 'branch',
      entryPort: { node: 'read', port: 'gen' }
    }
  ]
})

/** A minimal valid kind:'turn' narrator doc: one builtin main-output node. */
const goodNarrator = (name = 'Custom Narrator'): WorkflowDoc => ({
  id: 'narr',
  name,
  version: 1,
  schemaVersion: 1,
  kind: 'turn',
  nodes: [{ id: 'ctx', type: 'input.context', isMainOutput: true }],
  edges: []
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-recipe-'))
const writeTmp = (text: string): string => {
  const p = path.join(tmpDir, `f-${randomUUID()}.rptrecipe`)
  fs.writeFileSync(p, text, 'utf-8')
  return p
}
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  state.packs = []
  state.activation = []
  state.overrides = []
  // workflowService writes the selection sidecar + narrator docs under dataRoot/profiles/*; wipe them
  // between tests so a narrator selection set in one test doesn't leak into another's export.
  fs.rmSync(path.join(dataRoot, 'profiles'), { recursive: true, force: true })
  Object.values(store).forEach((fn) => fn.mockReset())
  mockLog.log.mockReset()
  mockApp.getVersion.mockReset().mockReturnValue('1.0.0')
  mockTemplates.listTableTemplates.mockReset().mockReturnValue([])
  mockTemplates.saveTableTemplate.mockReset().mockImplementation(() => `tpl-${randomUUID()}`)
  mockChatService.getChat.mockReset().mockReturnValue(null)
  mockChatService.getChatWorkflowId.mockReset().mockReturnValue(null)

  store.encodeScope.mockImplementation(realEncodeScope)
  store.resolveGate.mockImplementation(realResolveGate)
  store.listPackRecords.mockImplementation((_p: string) => state.packs)
  store.getPackIdentity.mockImplementation((_p: string, id: string, version: number) => {
    const found = state.packs.find((x) => x.id === id && x.version === version)
    return found ? { id: found.id, version: found.version } : null
  })
  store.getPackRecord.mockImplementation((_p: string, id: string, version?: number) => {
    const matches = state.packs.filter(
      (x) => x.id === id && (version == null || x.version === version)
    )
    if (matches.length === 0) return null
    return [...matches].sort((a, b) => b.version - a.version)[0]
  })
  store.listPackVersions.mockImplementation((_p: string, id: string) =>
    state.packs
      .filter((x) => x.id === id)
      .map((x) => x.version)
      .sort((a, b) => a - b)
  )
  store.insertPack.mockImplementation((_p: string, x: AgentPackRecord) => state.packs.push(x))
  store.packToSummary.mockImplementation((x: AgentPackRecord) => ({
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
  store.listActivationRows.mockImplementation((id: string) =>
    state.activation.filter((r) => r.packId === id)
  )
  store.listOverrideRows.mockImplementation((id: string) =>
    state.overrides.filter((r) => r.packId === id)
  )
  // Functional gate/override writes so real agentPackService.setGate/setActiveVersion/setOverride land
  // in state (the recipe confirm exercises them). upsertGate: world-scope (chatId null) upsert with pin.
  store.upsertGate.mockImplementation(
    (
      packId: string,
      worldId: string,
      chatId: string | null,
      open: boolean,
      pinVersion: number | null = null
    ) => {
      const existing = state.activation.find(
        (r) => r.packId === packId && r.worldId === worldId && r.chatId === (chatId ?? null)
      )
      if (existing) {
        existing.gateOpen = open
        if (pinVersion != null) existing.pinVersion = pinVersion
      } else {
        state.activation.push({
          packId,
          worldId,
          chatId: chatId ?? null,
          gateOpen: open,
          denial: [],
          pinVersion
        })
      }
    }
  )
  store.setActivePinVersion.mockImplementation(
    (packId: string, worldId: string, version: number) => {
      let changed = 0
      for (const r of state.activation) {
        if (r.packId === packId && r.worldId === worldId) {
          r.pinVersion = version
          changed++
        }
      }
      return changed
    }
  )
  store.upsertOverride.mockImplementation(
    (packId: string, scope: string, settingId: string, value: unknown) => {
      const existing = state.overrides.find(
        (r) => r.packId === packId && r.scope === scope && r.settingId === settingId
      )
      if (existing) existing.value = value
      else state.overrides.push({ packId, scope, settingId, value })
    }
  )
})

afterEach(() => setEnabledFragmentsProvider())

// A helper to seed a world's activation + override state directly (the "current world" the exporter reads).
const seedWorldGate = (
  packId: string,
  worldId: string,
  gateOpen: boolean,
  pinVersion: number | null
): void => {
  state.activation.push({ packId, worldId, chatId: null, gateOpen, denial: [], pinVersion })
}
const seedWorldOverride = (
  packId: string,
  worldId: string,
  settingId: string,
  value: unknown
): void => {
  state.overrides.push({ packId, scope: realEncodeScope({ world: worldId }), settingId, value })
}

// Real workflow-doc save + world narrator selection (the export path reads them; import saves them).
const createNarratorDoc = (profileId: string, name: string): string => {
  const res = realCreateWorkflow(profileId, goodNarrator(name))
  if (!res.ok) throw new Error(res.error)
  return res.id
}
const setWorldNarrator = (profileId: string, worldId: string, id: string): void =>
  realSetWorld(profileId, worldId, id)

/** Export a seeded world to a recipe file, returning the path. */
const exportSeededWorld = (profileId: string, worldId: string, name = 'Recipe'): string => {
  const p = path.join(tmpDir, `exp-${randomUUID()}.rptrecipe`)
  const res = recipe.writeRecipeExport(profileId, worldId, { name }, p)
  if (!res.ok) throw new Error(res.error.code)
  return p
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('recipe export', () => {
  it('assembles a world: a gate-OPEN pack + a gate-CLOSED-with-row pack + overrides + custom narrator', () => {
    const WORLD = 'world-A'
    state.packs = [pack({ id: 'pack.open', version: 2 }), pack({ id: 'pack.closed', version: 3 })]
    seedWorldGate('pack.open', WORLD, true, 2)
    seedWorldGate('pack.closed', WORLD, false, 3) // closed BUT has a world activation row → included, enabled:false
    seedWorldOverride('pack.open', WORLD, 'threshold', 5)
    // Point the world's narrator selection at a saved custom doc.
    const narratorId = createNarratorDoc('P', 'My Narrator')
    setWorldNarrator('P', WORLD, narratorId)

    const built = recipe.buildRecipeFromWorld('P', WORLD, { name: 'World A Setup', creator: 'me' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const env = built.envelope.recipe
    // Both packs embedded (closed one still has a world row).
    expect(env.packs.map((p) => p.id).sort()).toEqual(['pack.closed', 'pack.open'])
    // Activation: open → enabled true; closed-with-row → enabled false.
    const act = Object.fromEntries(env.activation.map((a) => [a.packId, a]))
    expect(act['pack.open'].enabled).toBe(true)
    expect(act['pack.open'].version).toBe(2)
    expect(act['pack.closed'].enabled).toBe(false)
    // Overrides carried scope-stripped (settingId → value).
    expect(act['pack.open'].overrides).toEqual({ threshold: 5 })
    expect(act['pack.closed'].overrides).toBeUndefined()
    // Narrator embedded.
    expect(env.narrator.kind).toBe('embedded')
    if (env.narrator.kind === 'embedded') expect(env.narrator.doc.name).toBe('My Narrator')
  })

  it('builtin-narrator world → narrator kind "builtin" (no doc embedded)', () => {
    const WORLD = 'world-B'
    state.packs = [pack()]
    seedWorldGate('pack.memory', WORLD, true, 2)
    // No world narrator selection → resolves to builtin.
    const built = recipe.buildRecipeFromWorld('P', WORLD, { name: 'B' })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.envelope.recipe.narrator.kind).toBe('builtin')
  })

  it('OMITS a library pack the world NEVER activated (no activation row)', () => {
    const WORLD = 'world-C'
    state.packs = [pack({ id: 'pack.on', version: 1 }), pack({ id: 'pack.never', version: 1 })]
    seedWorldGate('pack.on', WORLD, true, 1)
    // pack.never has no activation row in this world.
    const built = recipe.buildRecipeFromWorld('P', WORLD, { name: 'C' })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.envelope.recipe.packs.map((p) => p.id)).toEqual(['pack.on'])
  })

  it('OMITS a builtin pack (importer has it) but still exports the recipe', () => {
    const WORLD = 'world-D'
    state.packs = [
      pack({ id: 'pack.custom', version: 1, builtin: false }),
      pack({ id: 'pack.builtin', version: 1, builtin: true })
    ]
    seedWorldGate('pack.custom', WORLD, true, 1)
    seedWorldGate('pack.builtin', WORLD, true, 1)
    const built = recipe.buildRecipeFromWorld('P', WORLD, { name: 'D' })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.envelope.recipe.packs.map((p) => p.id)).toEqual(['pack.custom'])
  })

  it('a world with NO activated (non-builtin) packs → no-activated-packs error', () => {
    const WORLD = 'world-empty'
    state.packs = [pack()]
    // No activation row seeded.
    const built = recipe.buildRecipeFromWorld('P', WORLD, { name: 'empty' })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error.code).toBe('no-activated-packs')
  })

  it('preview mirrors the built recipe (pack list, narrator kind, size)', () => {
    const WORLD = 'world-P'
    state.packs = [pack()]
    seedWorldGate('pack.memory', WORLD, true, 2)
    const prev = recipe.previewRecipeExport('P', WORLD, { name: 'Prev' })
    expect(prev.ok).toBe(true)
    if (prev.ok) {
      expect(prev.preview.packs).toEqual([
        { id: 'pack.memory', version: 2, name: 'Memory Keeper', enabled: true }
      ])
      expect(prev.preview.narratorKind).toBe('builtin')
      expect(prev.preview.recipeMeta.sizeBytes).toBeGreaterThan(0)
      expect(prev.preview.noTemplatesBundled).toBe(true)
    }
  })

  it('writeRecipeExport writes parseable UTF-8 .rptrecipe; recipeFileName sanitizes', () => {
    const WORLD = 'world-W'
    state.packs = [pack()]
    seedWorldGate('pack.memory', WORLD, true, 2)
    const p = path.join(tmpDir, 'out.rptrecipe')
    const res = recipe.writeRecipeExport('P', WORLD, { name: 'W' }, p)
    expect(res.ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(p, 'utf-8')).kind).toBe('rptrecipe')
    expect(recipe.recipeFileName('a/b:c')).toBe('a_b_c.rptrecipe')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// IMPORT: inspect → confirm
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('recipe import — inspect', () => {
  it('inspects a clean file: per-pack sub-reports, dedupe "new", not blocked, a token', () => {
    // Build an export first (a real round-trip source).
    const WORLD = 'src-world'
    state.packs = [pack()]
    seedWorldGate('pack.memory', WORLD, true, 2)
    const file = exportSeededWorld('P', WORLD)

    // Fresh store for the import target.
    state.packs = []
    state.activation = []
    const report = recipe.inspectRecipeFile('P2', file)
    expect(report.parseError).toBeUndefined()
    expect(report.token).toBeDefined()
    expect(report.blocked).toBe(false)
    expect(report.packs).toHaveLength(1)
    expect(report.packs[0].id).toBe('pack.memory')
    expect(report.packs[0].dedupe).toBe('new')
    expect(report.packs[0].capabilityReport.capabilities).toContain('reads-tables')
    expect(report.narrator?.kind).toBe('builtin')
  })

  it('reports a parse failure with no token (unreadable file)', () => {
    const report = recipe.inspectRecipeFile('P', writeTmp('not json'))
    expect(report.parseError).toBeDefined()
    expect(report.token).toBeUndefined()
  })

  it('dedupe: same id+version installed → "already-installed"; different version → "new-version"', () => {
    const WORLD = 'src'
    state.packs = [pack({ version: 2 })]
    seedWorldGate('pack.memory', WORLD, true, 2)
    const file = exportSeededWorld('P', WORLD)

    // already-installed
    state.packs = [pack({ version: 2 })]
    state.activation = []
    expect(recipe.inspectRecipeFile('P2', file).packs[0].dedupe).toBe('already-installed')

    // new-version (id installed at a DIFFERENT version)
    state.packs = [pack({ version: 9 })]
    expect(recipe.inspectRecipeFile('P2', file).packs[0].dedupe).toBe('new-version')
  })

  it('one broken pack (unknown node type) BLOCKS the recipe; the per-pack report names it', () => {
    const WORLD = 'src'
    const badFrag = goodFragment()
    badFrag.nodes.push({ id: 'x', type: 'made.up.future.node' })
    state.packs = [
      pack({ id: 'pack.ok', version: 1 }),
      pack({ id: 'pack.bad', version: 1, fragment: badFrag })
    ]
    seedWorldGate('pack.ok', WORLD, true, 1)
    seedWorldGate('pack.bad', WORLD, true, 1)
    const file = exportSeededWorld('P', WORLD)

    state.packs = []
    state.activation = []
    const report = recipe.inspectRecipeFile('P2', file)
    expect(report.blocked).toBe(true)
    const bad = report.packs.find((p) => p.id === 'pack.bad')
    expect(bad?.unknownNodeTypes).toContain('made.up.future.node')
    const ok = report.packs.find((p) => p.id === 'pack.ok')
    expect(ok?.unknownNodeTypes).toEqual([]) // per-pack: the good one is clean
  })

  it('embedded narrator with an unknown node type BLOCKS the recipe', () => {
    // createWorkflowFromDoc validates node types at SAVE, so an unknown-node narrator can't be saved
    // locally — it only arrives via a recipe file authored on a NEWER RPT. So export a clean recipe,
    // then splice the bogus node into the embedded narrator doc in the file (the realistic path).
    const WORLD = 'src'
    state.packs = [pack()]
    seedWorldGate('pack.memory', WORLD, true, 2)
    const nid = createNarratorDoc('P', 'Narrator N')
    setWorldNarrator('P', WORLD, nid)
    const file = exportSeededWorld('P', WORLD)
    const obj = JSON.parse(fs.readFileSync(file, 'utf-8'))
    obj.recipe.narrator.doc.nodes.push({ id: 'z', type: 'made.up.narrator.node' })
    const spliced = writeTmp(JSON.stringify(obj))

    state.packs = []
    state.activation = []
    const report = recipe.inspectRecipeFile('P2', spliced)
    expect(report.blocked).toBe(true)
    expect(report.narrator?.unknownNodeTypes).toContain('made.up.narrator.node')
  })
})

describe('recipe import — confirm (round-trip into a FRESH world)', () => {
  it('clean round-trip: packs installed + pinned, gates set, overrides at world scope, narrator applied', () => {
    // Export a source world with 2 packs (one open, one closed-with-row), an override, a custom narrator.
    const SRC = 'src-world'
    state.packs = [pack({ id: 'pack.open', version: 2 }), pack({ id: 'pack.closed', version: 3 })]
    seedWorldGate('pack.open', SRC, true, 2)
    seedWorldGate('pack.closed', SRC, false, 3)
    seedWorldOverride('pack.open', SRC, 'threshold', 7)
    const nid = createNarratorDoc('P', 'Round Trip Narrator')
    setWorldNarrator('P', SRC, nid)
    const file = exportSeededWorld('P', SRC, 'RT')

    // FRESH target: clean store + a DIFFERENT profile (so the narrator name round-trips exactly — the
    // source profile 'P' already holds a "Round Trip Narrator", which would trigger the (copy) suffix).
    state.packs = []
    state.activation = []
    state.overrides = []
    const TGT = 'target-world'
    const TGTP = 'P-target'
    const report = recipe.inspectRecipeFile(TGTP, file)
    expect(report.blocked).toBe(false)
    const res = recipe.confirmRecipeImport(report.token!, TGT)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Packs installed, both versions present.
    expect(state.packs.map((p) => `${p.id}@${p.version}`).sort()).toEqual([
      'pack.closed@3',
      'pack.open@2'
    ])
    // Gates applied to the TARGET world: open enabled, closed disabled; versions pinned.
    const openRow = state.activation.find((r) => r.packId === 'pack.open' && r.worldId === TGT)
    const closedRow = state.activation.find((r) => r.packId === 'pack.closed' && r.worldId === TGT)
    expect(openRow?.gateOpen).toBe(true)
    expect(openRow?.pinVersion).toBe(2)
    expect(closedRow?.gateOpen).toBe(false)
    // Override wrapped at the TARGET world's scope.
    const ov = state.overrides.find(
      (r) => r.packId === 'pack.open' && r.scope === realEncodeScope({ world: TGT })
    )
    expect(ov?.value).toBe(7)
    // Narrator applied: a fresh workflow doc saved + the target world's selection points at it.
    expect(res.applied.narrator?.kind).toBe('embedded')
    const selection = getSelection(TGTP)
    expect(selection.worlds[TGT]).toBe(res.applied.narrator!.workflowId)
    expect(getWorkflowById(TGTP, selection.worlds[TGT])?.name).toBe('Round Trip Narrator')
  })

  it('builtin narrator: confirm pins the target world sidecar to the builtin id explicitly', () => {
    const SRC = 'src'
    state.packs = [pack()]
    seedWorldGate('pack.memory', SRC, true, 2)
    const file = exportSeededWorld('P', SRC)

    state.packs = []
    state.activation = []
    const TGT = 'tgt-builtin'
    const report = recipe.inspectRecipeFile('P', file)
    const res = recipe.confirmRecipeImport(report.token!, TGT)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.applied.narrator).toEqual({ kind: 'builtin', workflowId: 'default' })
    expect(getSelection('P').worlds[TGT]).toBe('default')
  })

  it('dedupe: a different version installs ALONGSIDE at confirm (both coexist)', () => {
    const SRC = 'src'
    state.packs = [pack({ version: 2 })]
    seedWorldGate('pack.memory', SRC, true, 2)
    const file = exportSeededWorld('P', SRC)

    state.packs = [pack({ version: 9 })] // a DIFFERENT version already installed
    state.activation = []
    const report = recipe.inspectRecipeFile('P', file)
    expect(report.packs[0].dedupe).toBe('new-version')
    const res = recipe.confirmRecipeImport(report.token!, 'tgt')
    expect(res.ok).toBe(true)
    expect(
      state.packs
        .filter((p) => p.id === 'pack.memory')
        .map((p) => p.version)
        .sort()
    ).toEqual([2, 9])
  })

  it('confirm REFUSES a blocked recipe (unknown node type), reporting the per-pack breakdown', () => {
    const SRC = 'src'
    const badFrag = goodFragment()
    badFrag.nodes.push({ id: 'x', type: 'made.up.future.node' })
    state.packs = [pack({ fragment: badFrag })]
    seedWorldGate('pack.memory', SRC, true, 2)
    const file = exportSeededWorld('P', SRC)

    state.packs = []
    state.activation = []
    const report = recipe.inspectRecipeFile('P', file)
    const res = recipe.confirmRecipeImport(report.token!, 'tgt')
    expect(res.ok).toBe(false)
    if (!res.ok && res.code === 'blocked')
      expect(res.packs.some((p) => p.unknownNodeTypes.includes('made.up.future.node'))).toBe(true)
    expect(state.packs).toHaveLength(0) // nothing installed
  })

  it('installs bundled templates first (saveTableTemplate called; applied.templates lists them)', () => {
    // Hand-build a recipe with a bundled template (v0 export bundles none, so splice into the file).
    const SRC = 'src'
    state.packs = [pack()]
    seedWorldGate('pack.memory', SRC, true, 2)
    const file = exportSeededWorld('P', SRC)
    const obj = JSON.parse(fs.readFileSync(file, 'utf-8'))
    obj.bundledTemplates = [
      {
        name: 'Bundled',
        sourceFormat: 'native',
        tables: [{ uid: 'u1', sqlName: 'notes', ddl: 'CREATE TABLE notes(id)' }]
      }
    ]
    const withTpl = writeTmp(JSON.stringify(obj))
    mockTemplates.saveTableTemplate.mockReturnValue('tpl-42')

    state.packs = []
    state.activation = []
    const report = recipe.inspectRecipeFile('P', withTpl)
    expect(report.templatePlans).toEqual([{ name: 'Bundled', outcome: 'will-install' }])
    const res = recipe.confirmRecipeImport(report.token!, 'tgt')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.applied.templates).toEqual([{ name: 'Bundled', id: 'tpl-42' }])
    expect(mockTemplates.saveTableTemplate).toHaveBeenCalledTimes(1)
  })

  it('partial failure: a mid-sequence throw returns "partial" listing what landed', () => {
    const SRC = 'src'
    state.packs = [pack()]
    seedWorldGate('pack.memory', SRC, true, 2)
    const file = exportSeededWorld('P', SRC)

    state.packs = []
    state.activation = []
    const report = recipe.inspectRecipeFile('P', file)
    // Make the activation step throw AFTER packs + narrator landed: upsertGate throws.
    store.upsertGate.mockImplementationOnce(() => {
      throw new Error('gate write exploded')
    })
    const res = recipe.confirmRecipeImport(report.token!, 'tgt')
    expect(res.ok).toBe(false)
    if (!res.ok && res.code === 'partial') {
      expect(res.failedStep).toBe('activation')
      expect(res.error).toContain('gate write exploded')
      // Packs + narrator landed before the throw.
      expect(res.applied.packs.map((p) => p.id)).toEqual(['pack.memory'])
      expect(res.applied.narrator?.kind).toBe('builtin')
      expect(res.applied.activation).toEqual([]) // the throw was on the first activation entry
    }
    expect(state.packs).toHaveLength(1) // the pack DID install (no rollback)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// cancel + TTL
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('recipe cancel + TTL cleanup', () => {
  const seedAndExport = (): string => {
    const SRC = 'src'
    state.packs = [pack()]
    seedWorldGate('pack.memory', SRC, true, 2)
    const file = exportSeededWorld('P', SRC)
    state.packs = []
    state.activation = []
    return file
  }

  it('cancel drops the token: a subsequent confirm is expired', () => {
    const report = recipe.inspectRecipeFile('P', seedAndExport())
    recipe.cancelRecipeImport(report.token!)
    const res = recipe.confirmRecipeImport(report.token!, 'tgt')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('expired')
  })

  it('confirm consumes the token (single-use): a second confirm is expired', () => {
    const report = recipe.inspectRecipeFile('P', seedAndExport())
    expect(recipe.confirmRecipeImport(report.token!, 'tgt').ok).toBe(true)
    const again = recipe.confirmRecipeImport(report.token!, 'tgt')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('expired')
  })

  it('an expired token is swept: confirm after TTL is expired', () => {
    vi.useFakeTimers()
    try {
      const report = recipe.inspectRecipeFile('P', seedAndExport())
      vi.advanceTimersByTime(recipe.RECIPE_IMPORT_TOKEN_TTL_MS + 1)
      recipe.sweepExpiredRecipeImports()
      const res = recipe.confirmRecipeImport(report.token!, 'tgt')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })
})
