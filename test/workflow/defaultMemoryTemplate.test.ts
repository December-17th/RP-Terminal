import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { WorkflowDoc } from '../../src/shared/workflow/types'

// The merged default doc (agent-memory-ux WP-C; spec §3.2). Three layers:
//  1. shape pins — the template validates (structural + graph + per-node config, the same three
//     gates validateWorkflowDoc runs), carries the group/exposed/meta contract, and keeps the
//     maintainer prompt VERBATIM from the proven fixture;
//  2. ship-default (every_turn) TURN equivalence to the narrator spine (NARRATOR_SPINE_DOC) at the
//     trace level — the memory group is trigger-rooted, so a TURN excludes it regardless of mode
//     (both fail-soft recall paths, no bound table template);
//  3. headless mode discrimination through the REAL closure mechanics (evaluateDocTriggers), the
//     owner-facing acceptance ("flipping selected changes which trigger's run survives").
// The runtime layers reuse memoryFillChain.test.ts's proven mock harness.

const mockAgentPack = vi.hoisted(() => ({ enabledFragmentsFor: vi.fn(() => []) }))
vi.mock('../../src/main/services/agentPackService', () => mockAgentPack)

const floors = Array.from({ length: 6 }, (_, i) => ({
  floor: i,
  user_message: { content: `player action ${i}` },
  response: { content: `ai reply ${i}` },
  variables: {}
}))
const mockChat = vi.hoisted(() => ({
  getChat: vi.fn(() => ({ character_id: 'w1', floor_count: 6 })),
  getChatTableTemplateId: vi.fn<() => string | null>(() => null),
  getChatLorebookIds: vi.fn(() => null),
  getChatMode: vi.fn(() => 'explore'),
  isYuzuMode: vi.fn(() => false),
  getChatWorkflowId: vi.fn(() => null),
  getCachedWorldInfo: vi.fn(() => null),
  setCachedWorldInfo: vi.fn()
}))
vi.mock('../../src/main/services/chatService', () => mockChat)

const mockFloor = vi.hoisted(() => {
  const getAllFloors = vi.fn(() => floors)
  return {
    getFloor: vi.fn(() => floors[floors.length - 1]),
    getAllFloors,
    // Count-only reads go through getFloorCount now — keep it slaved to the same fixture.
    getFloorCount: vi.fn(() => (getAllFloors() as unknown[] | undefined)?.length ?? 0),
    getFloorRequest: vi.fn(() => undefined),
    saveFloor: vi.fn()
  }
})
vi.mock('../../src/main/services/floorService', () => mockFloor)

const mockTableStatus = vi.hoisted(() => ({ getTablesStatus: vi.fn(() => ({}) as Record<string, unknown>) }))
vi.mock('../../src/main/services/tableStatusService', () => mockTableStatus)

import { TableTemplateSchema } from '../../src/main/types/tableTemplate'
const TEMPLATE = TableTemplateSchema.parse({
  name: 'mem',
  tables: [
    {
      uid: 't1',
      sqlName: 'summary',
      displayName: '纪要',
      ddl: 'CREATE TABLE summary (t TEXT)',
      headers: ['t'],
      updateFrequency: 1
    }
  ]
})
const mockTemplate = vi.hoisted(() => ({ getTableTemplateById: vi.fn(() => null as unknown) }))
vi.mock('../../src/main/services/tableTemplateService', () => mockTemplate)

const progress = vi.hoisted(() => ({ store: {} as Record<string, number> }))
const mockProgress = vi.hoisted(() => ({
  getProgress: vi.fn(() => ({}) as Record<string, number>),
  advanceProgress: vi.fn(),
  computeTableProgress: vi.fn(),
  resolveUpdateFrequency: (freq: number, globalDefault: number): number | null =>
    freq === 0 ? null : freq >= 1 ? freq : Math.max(1, Math.floor(globalDefault) || 3)
}))
vi.mock('../../src/main/services/tableProgressService', () => mockProgress)

const mockSql = vi.hoisted(() => ({
  applySqlBatch: vi.fn(() => ({
    applied: 1,
    changes: 1,
    statements: ['INSERT INTO summary VALUES (1)']
  })),
  executeReadQuery: vi.fn(),
  TableSqlError: class extends Error {}
}))
vi.mock('../../src/main/services/tableSql', () => mockSql)
const mockOps = vi.hoisted(() => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(() => true),
  endTableWrite: vi.fn()
}))
vi.mock('../../src/main/services/tableOpsService', () => mockOps)
const mockDb = vi.hoisted(() => ({ readAllTables: vi.fn(() => []) }))
vi.mock('../../src/main/services/tableDbService', () => mockDb)

const mockCallModel = vi.hoisted(() => ({
  callModel: vi.fn(async () => ({
    raw: '<TableEdit>INSERT INTO summary VALUES (1)</TableEdit>',
    rawUsage: {}
  }))
}))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)

const docTriggerState = vi.hoisted(
  () => new Map<string, { lastValue: number | null; lastFireFloor: number | null }>()
)
const mockDocTriggerStore = vi.hoisted(() => ({
  getDocTriggerState: vi.fn(
    (c: string, d: string, n: string) => docTriggerState.get(`${c}|${d}|${n}`) ?? null
  ),
  setDocTriggerLastValue: vi.fn((c: string, d: string, n: string, v: number) => {
    const k = `${c}|${d}|${n}`
    docTriggerState.set(k, {
      lastValue: v,
      lastFireFloor: docTriggerState.get(k)?.lastFireFloor ?? null
    })
  }),
  setDocTriggerLastFireFloor: vi.fn((c: string, d: string, n: string, f: number) => {
    const k = `${c}|${d}|${n}`
    docTriggerState.set(k, {
      lastValue: docTriggerState.get(k)?.lastValue ?? null,
      lastFireFloor: f
    })
  })
}))
vi.mock('../../src/main/services/workflowTriggerStore', () => mockDocTriggerStore)

const mockPackTriggerStore = vi.hoisted(() => ({
  getTriggerState: vi.fn(() => null),
  setTriggerLastValue: vi.fn(),
  setTriggerLastFireFloor: vi.fn()
}))
vi.mock('../../src/main/services/agentPackTriggerStore', () => mockPackTriggerStore)

const mockEvents = vi.hoisted(() => ({ notifyWorkflowTrace: vi.fn(), notifyWorkflowPanel: vi.fn() }))
vi.mock('../../src/main/services/workflowEvents', () => mockEvents)
const mockRunHistory = vi.hoisted(() => ({ appendRun: vi.fn() }))
vi.mock('../../src/main/services/runHistoryStore', () => mockRunHistory)
const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../../src/main/services/logService', () => mockLog)

import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
vi.mock('../../src/main/services/settingsService', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const s = (real.getDefaultSettings as typeof getDefaultSettings)()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'm' }
  s.agent = { mode: 'off' }
  return { ...real, getSettings: () => s }
})
vi.mock('../../src/main/services/characterService', () => ({
  getCharacter: () => ({ id: 'w1', data: { name: 'C', description: '', extensions: {} } })
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLorebookById: () => ({ id: 'w1', name: 'lb', entries: [] })
}))
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [], getWorldInfoRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({})
}))
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => getDefaultPreset(),
  getActivePresetId: () => 'p'
}))

const mockWorkflowService = vi.hoisted(() => ({
  resolveWorkflowDoc: vi.fn<() => { id: string; doc: WorkflowDoc }>()
}))
vi.mock('../../src/main/services/workflowService', () => mockWorkflowService)

vi.mock('../../src/main/services/generation/persistFloor', () => ({ persistFloor: vi.fn(() => 6) }))

import { evaluateDocTriggers } from '../../src/main/services/headlessRunService'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { RunContext } from '../../src/main/services/nodes/types'
import { parseWorkflowDoc } from '../../src/shared/workflow/docSchema'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { NARRATOR_SPINE_DOC as DEFAULT_GRAPH } from '../fixtures/narratorSpineDoc'
import {
  buildDefaultMemoryDoc,
  buildDefaultMemoryDocV2,
  DEFAULT_MEMORY_SEED_MARKER,
  DEFAULT_MEMORY_SEED_MARKER_V2,
  MAINTAINER_SYSTEM_PROMPT
} from '../../src/main/services/nodes/builtin/defaultMemoryTemplate'

/** The template with the mode's `selected` overridden (the owner's flip). */
const docWithMode = (selected: string): WorkflowDoc => {
  const doc = buildDefaultMemoryDoc()
  const mode = doc.nodes.find((n) => n.id === 'mode')!
  mode.config = { ...(mode.config as Record<string, unknown>), selected }
  return doc
}

const MEMORY_CHAIN_IDS = ['history', 'read', 'agent', 'sql', 'tableapply', 'log-apply']

beforeEach(() => {
  docTriggerState.clear()
  progress.store = {}
  mockAgentPack.enabledFragmentsFor.mockReset().mockReturnValue([])
  mockChat.getChat.mockReset().mockReturnValue({ character_id: 'w1', floor_count: 6 })
  mockChat.getChatTableTemplateId.mockReset().mockReturnValue(null)
  mockChat.getChatLorebookIds.mockReset().mockReturnValue(null)
  mockChat.getChatMode.mockReset().mockReturnValue('explore')
  mockChat.getCachedWorldInfo.mockReset().mockReturnValue(null)
  mockFloor.getFloor.mockReset().mockReturnValue(floors[floors.length - 1])
  mockFloor.getAllFloors.mockReset().mockReturnValue(floors)
  mockTableStatus.getTablesStatus.mockReset().mockReturnValue({})
  mockTemplate.getTableTemplateById.mockReset().mockReturnValue(null)
  mockProgress.getProgress.mockReset().mockImplementation(() => ({ ...progress.store }))
  mockProgress.advanceProgress
    .mockReset()
    .mockImplementation((_p, _c, names: string[], f: number) => {
      for (const n of names) progress.store[n] = Math.max(progress.store[n] ?? -1, f)
    })
  mockSql.applySqlBatch
    .mockReset()
    .mockReturnValue({ applied: 1, changes: 1, statements: ['INSERT INTO summary VALUES (1)'] })
  mockOps.tryBeginTableWrite.mockReset().mockReturnValue(true)
  mockDb.readAllTables.mockReset().mockReturnValue([])
  mockCallModel.callModel
    .mockReset()
    .mockResolvedValue({ raw: '<TableEdit>INSERT INTO summary VALUES (1)</TableEdit>', rawUsage: {} })
  mockRunHistory.appendRun.mockReset()
  mockEvents.notifyWorkflowTrace.mockReset()
  mockLog.log.mockReset()
})

/** Bind the table template + a 6-floor backlog, memoryFillChain.test.ts's exact status shape. */
const bindTemplateWithBacklog = (): void => {
  mockChat.getChatTableTemplateId.mockReturnValue('tmpl')
  mockTemplate.getTableTemplateById.mockReturnValue(TEMPLATE)
  mockTableStatus.getTablesStatus.mockImplementation(() => {
    const last = progress.store.summary ?? -1
    return {
      summary: {
        lastFloor: last < 0 ? null : last,
        processed: last + 1,
        nextExpected: last + 1,
        unprocessed: Math.max(0, 5 - last)
      }
    }
  })
}

// ── 1. shape pins ─────────────────────────────────────────────────────────────────────────────────

describe('default memory template — shape', () => {
  const doc = buildDefaultMemoryDoc()

  it('passes the full save gate (structural + graph rules incl. groups + per-node config)', () => {
    // The same three gates workflowService.validateWorkflowDoc runs (replicated pure — this suite
    // mocks workflowService for the headless layer below).
    const structural = parseWorkflowDoc(JSON.parse(JSON.stringify(doc)))
    expect(structural.ok).toBe(true)
    if (!structural.ok) return
    const v = validateWorkflow(structural.doc, builtinRegistry.descriptors())
    if (!v.ok) throw new Error(v.errors.map((e) => e.message).join('; '))
    for (const n of structural.doc.nodes) {
      const schema = builtinRegistry.get(n.type)?.configSchema
      if (!schema) continue
      const r = schema.safeParse(n.config ?? {})
      if (!r.success) throw new Error(`${n.id} (${n.type}): ${r.error.message}`)
    }
  })

  it('carries the seed marker and the editable name "Default"', () => {
    expect(doc.name).toBe('Default')
    expect(doc.meta).toEqual({ seeded: DEFAULT_MEMORY_SEED_MARKER })
    expect(DEFAULT_MEMORY_SEED_MARKER).toBe('default-memory-v1')
  })

  it('keeps the maintainer SYSTEM prompt VERBATIM but ends on an inline-{history} user row', () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../docs/workflows/memory-fill-async.rptflow'), 'utf-8')
    ) as WorkflowDoc
    const fixtureAgent = fixture.nodes.find((n) => n.id === 'agent')!
    const fixtureMessages = (fixtureAgent.config as { messages: { role: string; content: string }[] })
      .messages
    // The system prompt stays byte-identical to the proven zh fixture...
    expect(MAINTAINER_SYSTEM_PROMPT).toBe(fixtureMessages[0].content)
    // ...but the fixture's two user rows (`【本批剧情】` + a standalone `{history}`) are MERGED into one
    // inline-{history} row so the composed prompt ends on a `user` turn. A standalone `{history}` row
    // splices the floors role-preserving and ends on the last floor's `assistant` reply, which makes
    // OpenAI-compatible Gemini endpoints return an empty completion.
    const agent = doc.nodes.find((n) => n.id === 'agent')!
    expect((agent.config as { messages: unknown }).messages).toEqual([
      { role: 'system', content: MAINTAINER_SYSTEM_PROMPT },
      { role: 'user', content: '【本批剧情】\n{history}' }
    ])
  })

  it('mode contract: three options (every_turn selected + "Every X turns" label), cadence→when1, backlog→when2, when3/when4 unwired', () => {
    const mode = doc.nodes.find((n) => n.id === 'mode')!
    expect(mode.type).toBe('control.mode')
    expect((mode.config as { options: { key: string }[] }).options.map((o) => o.key)).toEqual([
      'every_turn',
      'async',
      'off'
    ])
    // Ship default: every_turn, with the renamed display label (doc content, not i18n).
    expect((mode.config as { options: { key: string; label: string }[] }).options[0]).toEqual({
      key: 'every_turn',
      label: 'Every X turns'
    })
    expect((mode.config as { selected: string }).selected).toBe('every_turn')

    const into = (port: string) =>
      doc.edges.filter((e) => e.to.node === 'mode' && e.to.port === port).map((e) => e.from.node)
    expect(into('when1')).toEqual(['trigger-cadence'])
    expect(into('when2')).toEqual(['trigger-state'])
    expect(into('when3')).toEqual([]) // 'off' — the unwired dead end IS the off switch
    expect(into('when4')).toEqual([]) // free slot for an imported memory system (spec §3.2)
  })

  it('the chain hangs off mode.fired (not a trigger directly) at every gate', () => {
    for (const [node, port] of [
      ['history', 'when'],
      ['read', 'when'],
      ['agent', 'when'],
      ['sql', 'when']
    ] as const) {
      const gate = doc.edges.find((e) => e.to.node === node && e.to.port === port)
      expect(gate?.from).toEqual({ node: 'mode', port: 'fired' })
    }
    // table.apply keeps the fixture's parser-driven gate.
    const applyGate = doc.edges.find((e) => e.to.node === 'tableapply' && e.to.port === 'when')
    expect(applyGate?.from).toEqual({ node: 'sql', port: 'found' })
  })

  it('groups the whole memory system as ONE collapsed "Table memory" with the four exposed settings + note', () => {
    expect(doc.groups).toHaveLength(1)
    const g = doc.groups![0]
    expect(g.name).toBe('Table memory')
    expect(g.collapsed).toBe(true)
    expect([...g.nodeIds].sort()).toEqual(
      ['trigger-cadence', 'trigger-state', 'mode', ...MEMORY_CHAIN_IDS].sort()
    )
    expect(g.exposed).toEqual([
      { node: 'mode', path: 'selected', label: 'Mode' },
      { node: 'trigger-cadence', path: 'everyNFloors', label: 'Cadence (floors)' },
      { node: 'trigger-state', path: 'value', label: 'Backlog threshold' },
      { node: 'agent', path: 'api_preset_id', label: 'API preset' }
    ])
    expect(g.note).toContain('table template')
    // The narrator spine + recall stay OUTSIDE the group (they are shared turn wiring).
    for (const id of ['ctx', 'trim', 'export', 'assemble', 'llm', 'parse', 'apply', 'write'])
      expect(g.nodeIds).not.toContain(id)
  })

  it('turn path follows memory-fill-async: trim inline on the spine, export→assemble.entries', () => {
    expect(
      doc.edges.some((e) => e.from.node === 'ctx' && e.to.node === 'trim' && e.to.port === 'gen')
    ).toBe(true)
    expect(
      doc.edges.some((e) => e.from.node === 'trim' && e.to.node === 'assemble' && e.to.port === 'gen')
    ).toBe(true)
    const entries = doc.edges.find((e) => e.to.node === 'assemble' && e.to.port === 'entries')
    expect(entries?.from).toEqual({ node: 'export', port: 'entries' })
    // Every non-ctx DEFAULT_GRAPH edge is present verbatim; ctx.gen→X.gen spine feeds route via trim.
    const edgeKey = (e: { from: { node: string; port: string }; to: { node: string; port: string } }): string =>
      `${e.from.node}.${e.from.port}->${e.to.node}.${e.to.port}`
    const mergedEdges = new Set(doc.edges.map(edgeKey))
    for (const e of DEFAULT_GRAPH.edges) {
      if (e.from.node === 'ctx') {
        expect(mergedEdges.has(edgeKey({ from: { node: 'trim', port: 'gen' }, to: e.to }))).toBe(true)
      } else {
        expect(mergedEdges.has(edgeKey(e))).toBe(true)
      }
    }
  })
})

// ── 1b. v2 (memory.maintain single node) shape pins ─────────────────────────────────────────────────

describe('default memory template v2 — memory.maintain single node', () => {
  const doc = buildDefaultMemoryDocV2()

  it('passes the full save gate (structural + graph rules + per-node config)', () => {
    const structural = parseWorkflowDoc(JSON.parse(JSON.stringify(doc)))
    expect(structural.ok).toBe(true)
    if (!structural.ok) return
    const v = validateWorkflow(structural.doc, builtinRegistry.descriptors())
    if (!v.ok) throw new Error(v.errors.map((e) => e.message).join('; '))
    for (const n of structural.doc.nodes) {
      const schema = builtinRegistry.get(n.type)?.configSchema
      if (!schema) continue
      const r = schema.safeParse(n.config ?? {})
      if (!r.success) throw new Error(`${n.id} (${n.type}): ${r.error.message}`)
    }
  })

  it('carries the v2 marker + the editable name "Default"', () => {
    expect(doc.name).toBe('Default')
    expect(doc.meta).toEqual({ seeded: DEFAULT_MEMORY_SEED_MARKER_V2 })
    expect(DEFAULT_MEMORY_SEED_MARKER_V2).toBe('default-memory-v2')
  })

  it('replaces the five-node chain with ONE memory.maintain node gated by mode.fired; error → util.log', () => {
    for (const id of MEMORY_CHAIN_IDS.filter((i) => i !== 'log-apply')) {
      expect(doc.nodes.find((n) => n.id === id)).toBeUndefined()
    }
    const maintain = doc.nodes.find((n) => n.id === 'maintain')!
    expect(maintain.type).toBe('memory.maintain')
    expect(doc.edges.find((e) => e.to.node === 'maintain' && e.to.port === 'when')?.from).toEqual({
      node: 'mode',
      port: 'fired'
    })
    expect(doc.edges.find((e) => e.from.node === 'maintain' && e.from.port === 'error')?.to).toEqual({
      node: 'log-apply',
      port: 'value'
    })
    // Reuses the verbatim maintainer prompt ({{input}} alias → the rendered tables block), and merges
    // the two user rows into one inline-{history} row so the composed prompt ends on a `user` turn (a
    // trailing standalone-{history} row ends on the last floor's `assistant` reply → OpenAI-compatible
    // Gemini returns an empty completion).
    expect((maintain.config as { messages: { role: string; content: string }[] }).messages).toEqual([
      { role: 'system', content: MAINTAINER_SYSTEM_PROMPT },
      { role: 'user', content: '【本批剧情】\n{history}' }
    ])
  })

  it('groups the memory system with the Memory node api_preset exposed', () => {
    const g = doc.groups![0]
    expect(g.nodeIds).toEqual(['trigger-cadence', 'trigger-state', 'mode', 'maintain', 'log-apply'])
    expect(g.exposed).toContainEqual({ node: 'maintain', path: 'api_preset_id', label: 'API preset' })
  })
})

// ── 2. ship-default (every_turn) turn equivalence to the narrator spine ──────────────────────────

const turnCtx = (workflowId: string): RunContext => ({
  profileId: 'prof',
  chatId: 'c1',
  workflowId,
  userAction: 'do a thing',
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

describe('default memory template v2 — ship-default (every_turn) TURN skips the memory node (like v1)', () => {
  it('a turn run skips the whole memory group; the narrator still writes', async () => {
    const res = await runWorkflow(buildDefaultMemoryDocV2(), builtinRegistry, turnCtx('seeded-v2'))
    const status = new Map(res.traces.map((t) => [t.nodeId, t.status]))
    for (const id of ['trigger-cadence', 'trigger-state', 'mode', 'maintain', 'log-apply'])
      expect(status.get(id)).toBe('skipped')
    expect(status.get('write')).toBe('ran')
  })
})

describe('default memory template — ship-default (every_turn) TURN equivalence to the narrator spine (plan WP-C)', () => {
  it('narrator traces match, memory chain skipped, and the model sees the SAME prompt', async () => {
    // No bound table template (both fail-soft paths: trim no-ops at pointer 0, export is empty).
    const merged = await runWorkflow(buildDefaultMemoryDoc(), builtinRegistry, turnCtx('seeded'))
    const mergedSend = mockCallModel.callModel.mock.calls[0]?.[1]
    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)

    mockCallModel.callModel.mockClear()
    const plain = await runWorkflow(
      structuredClone(DEFAULT_GRAPH),
      builtinRegistry,
      turnCtx('default')
    )
    const plainSend = mockCallModel.callModel.mock.calls[0]?.[1]
    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)

    const mergedStatus = new Map(merged.traces.map((t) => [t.nodeId, t.status]))
    const plainStatus = new Map(plain.traces.map((t) => [t.nodeId, t.status]))
    // Narrator nodes: identical statuses in both runs.
    for (const id of ['ctx', 'assemble', 'llm', 'parse', 'apply', 'write']) {
      expect(mergedStatus.get(id)).toBe(plainStatus.get(id))
      expect(mergedStatus.get(id)).toBe('ran')
    }
    // The entire memory system (triggers excluded, mode gated, chain pruned) never runs on a turn.
    for (const id of ['trigger-cadence', 'trigger-state', 'mode', ...MEMORY_CHAIN_IDS]) {
      expect(mergedStatus.get(id)).toBe('skipped')
    }
    // Recall wiring ran fail-soft (trim no-op, export empty) WITHOUT changing the prompt:
    expect(mergedStatus.get('trim')).toBe('ran')
    expect(mergedStatus.get('export')).toBe('ran')
    expect(mergedSend).toEqual(plainSend)
    // No memory write happened in either turn.
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
  })

  it('turn behavior is mode-INDEPENDENT (triggers are excluded on turns regardless of selected)', async () => {
    for (const selected of ['every_turn', 'async']) {
      mockCallModel.callModel.mockClear()
      const res = await runWorkflow(docWithMode(selected), builtinRegistry, turnCtx('seeded'))
      const status = new Map(res.traces.map((t) => [t.nodeId, t.status]))
      expect(status.get('mode')).toBe('skipped')
      expect(status.get('agent')).toBe('skipped')
      expect(mockCallModel.callModel).toHaveBeenCalledTimes(1) // only the narrator's llm.sample
    }
  })
})

// ── 3. headless mode discrimination (the owner acceptance, through the real closure path) ─────────

describe('default memory template — headless mode flip (evaluateDocTriggers)', () => {
  it("mode=off: triggers fire but the chain gates off — no side LLM call, no SQL", async () => {
    bindTemplateWithBacklog()
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'seeded', doc: docWithMode('off') })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    expect(mockCallModel.callModel).not.toHaveBeenCalled()
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
    // The run still happened (visible in the drawer) — spec §3.4's accepted behavior.
    expect(mockRunHistory.appendRun).toHaveBeenCalled()
  })

  it('mode=every_turn: the cadence-fired chain runs — maintainer called, SQL lands, pointer advances', async () => {
    bindTemplateWithBacklog()
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'seeded',
      doc: docWithMode('every_turn')
    })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)
    const sent = mockCallModel.callModel.mock.calls[0][1] as { role: string; content: string }[]
    expect(sent[0].role).toBe('system')
    expect(sent[0].content).toContain('数据库表格维护AI')
    // The composed prompt ends on a `user` turn (merged inline-{history}), NOT a trailing `assistant`
    // reply — the OpenAI-compatible-Gemini empty-completion guard.
    expect(sent[sent.length - 1].role).toBe('user')
    expect(mockSql.applySqlBatch).toHaveBeenCalledTimes(1)
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('prof', 'c1', ['summary'], 5)
  })

  it('mode=async + only the cadence due (no backlog): the run gates off', async () => {
    bindTemplateWithBacklog()
    progress.store.summary = 5 // backlog 0 → the state trigger does not fire; cadence does
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'seeded', doc: docWithMode('async') })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    expect(mockCallModel.callModel).not.toHaveBeenCalled()
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
  })

  it('mode=async + backlog reached (cadence not due): the backlog-fired chain runs', async () => {
    bindTemplateWithBacklog()
    // Cadence not due: lastFire 4, floor 5 → 1 < 3. Backlog: pointer -1 → unprocessed 6 ≥ 6.
    docTriggerState.set('c1|seeded|trigger-cadence', { lastValue: null, lastFireFloor: 4 })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'seeded', doc: docWithMode('async') })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)
    expect(mockSql.applySqlBatch).toHaveBeenCalledTimes(1)
  })
})
