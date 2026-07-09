import { describe, it, expect, afterAll, afterEach, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

const mockChatService = vi.hoisted(() => ({
  getChatWorkflowId: vi.fn<(profileId: string, chatId: string) => string | null>(() => null),
  getChat: vi.fn<(profileId: string, chatId: string) => { character_id: string } | null>(
    () => null
  ),
  setChatWorkflowId: vi.fn(),
  removeWorkflowIdFromChats: vi.fn()
}))
vi.mock('../src/main/services/chatService', () => mockChatService)

import {
  BUILTIN_WORKFLOW_ID,
  listWorkflows,
  getWorkflowById,
  saveWorkflow,
  createWorkflowFromDoc,
  createWorkflow,
  cloneWorkflow,
  deleteWorkflow,
  importWorkflowFromFile,
  exportWorkflowToFile,
  getSelection,
  setGlobalWorkflow,
  setWorldWorkflow,
  resolveWorkflowId,
  resolveWorkflowDoc,
  resolveEffectiveDoc,
  setEnabledFragmentsProvider,
  setMemorySeedingEnabled,
  BUILTIN_DEFAULT_DOC
} from '../src/main/services/workflowService'
import { getAppDir } from '../src/main/services/storageService'
import { WorkflowDoc } from '../src/shared/workflow/types'
import { AttachmentDecl } from '../src/shared/workflow/attachments'
import { ComposeFragment } from '../src/shared/workflow/compose'

// Deliberate WP-C (agent-memory-ux) harness choice: this suite characterizes the PRE-SEED
// list/selection/resolution mechanics ("builtin when nothing selected", empty selection shapes),
// so the lazy default-memory seeding is disabled here via its test seam. Seeding behavior has its
// own suite: test/workflowSeeding.test.ts.
setMemorySeedingEnabled(false)

const profileId = `wf-test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

const minimalDoc = (overrides: Partial<WorkflowDoc> = {}): WorkflowDoc => ({
  id: 'placeholder',
  name: 'My Workflow',
  version: 1,
  schemaVersion: 1,
  nodes: [{ id: 'n1', type: 'input.context', isMainOutput: true }],
  edges: [],
  ...overrides
})

beforeEach(() => {
  mockChatService.getChatWorkflowId.mockReset().mockReturnValue(null)
  mockChatService.getChat.mockReset().mockReturnValue(null)
  mockChatService.setChatWorkflowId.mockReset()
  mockChatService.removeWorkflowIdFromChats.mockReset()
})

describe('workflowService', () => {
  it('listWorkflows does NOT inject the builtin (memory-default refactor: pure file list; seeding off here)', () => {
    const list = listWorkflows(profileId)
    // With seeding disabled and no user files, the list is empty — the builtin default doc is an
    // invisible fallback, never a list entry.
    expect(list).toEqual([])
    expect(list.some((w) => w.id === BUILTIN_WORKFLOW_ID || w.builtin)).toBe(false)
  })

  it('create -> get round-trips (doc.id rewritten, content preserved)', () => {
    const result = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Round Trip' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.id).not.toBe('placeholder')

    const fetched = getWorkflowById(profileId, result.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(result.id)
    expect(fetched!.name).toBe('Round Trip')
    expect(fetched!.nodes).toHaveLength(1)
  })

  it('saveWorkflow rejects the builtin id; deleteWorkflow(default) returns false', () => {
    const result = saveWorkflow(BUILTIN_WORKFLOW_ID, BUILTIN_WORKFLOW_ID, minimalDoc())
    expect(result.ok).toBe(false)

    expect(deleteWorkflow(profileId, BUILTIN_WORKFLOW_ID)).toBe(false)
  })

  it('saveWorkflow rejects a structurally-invalid doc and does not write a file', () => {
    const created = createWorkflowFromDoc(profileId, minimalDoc({ name: 'To Corrupt' }))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const badSchema = { ...minimalDoc({ id: created.id }), schemaVersion: 999 }
    const result = saveWorkflow(profileId, created.id, badSchema)
    expect(result.ok).toBe(false)

    // File is untouched — still the original valid doc.
    const fetched = getWorkflowById(profileId, created.id)
    expect(fetched!.name).toBe('To Corrupt')
  })

  it('saveWorkflow rejects a graph-invalid doc (two isMainOutput nodes)', () => {
    const created = createWorkflowFromDoc(profileId, minimalDoc({ name: 'To Corrupt 2' }))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const badGraph = minimalDoc({
      id: created.id,
      name: 'To Corrupt 2',
      nodes: [
        { id: 'n1', type: 'input.context', isMainOutput: true },
        { id: 'n2', type: 'output.writeFloor', isMainOutput: true }
      ]
    })
    const result = saveWorkflow(profileId, created.id, badGraph)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/main-output/)

    const fetched = getWorkflowById(profileId, created.id)
    expect(fetched!.name).toBe('To Corrupt 2')
  })

  it('cloneWorkflow(default) gets a fresh id, " (copy)" name, and keeps node ids', () => {
    const clone = cloneWorkflow(profileId, BUILTIN_WORKFLOW_ID)
    expect(clone).not.toBeNull()
    expect(clone!.id).not.toBe(BUILTIN_WORKFLOW_ID)
    // The builtin default doc is now the memory template ("Default", not "Default Generation").
    expect(clone!.name).toBe('Default (copy)')

    const doc = getWorkflowById(profileId, clone!.id)
    expect(doc).not.toBeNull()
    expect(doc!.id).toBe(clone!.id)
    expect(doc!.nodes.some((n) => n.id === 'ctx')).toBe(true)
  })

  it('cloneWorkflow numbers repeat clones instead of compounding "(copy) (copy)"', () => {
    // The earlier test already created 'Default (copy)'.
    const second = cloneWorkflow(profileId, BUILTIN_WORKFLOW_ID)
    expect(second!.name).toBe('Default (copy 2)')

    // Cloning a copy strips the suffix first — never 'X (copy 2) (copy)'.
    const third = cloneWorkflow(profileId, second!.id)
    expect(third!.name).toBe('Default (copy 3)')
  })

  it('listWorkflows flags an on-disk doc that fails validation with invalid: true', () => {
    const dir = path.join(profileDir, 'workflows')
    fs.mkdirSync(dir, { recursive: true })
    const invalidId = 'invalid-listed-doc'
    fs.writeFileSync(
      path.join(dir, `${invalidId}.json`),
      JSON.stringify({
        id: invalidId,
        name: 'Invalid Listed',
        version: 1,
        schemaVersion: 1,
        nodes: [{ id: 'n1', type: 'no.such.type', isMainOutput: true }],
        edges: []
      })
    )
    const valid = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Valid Listed' }))
    expect(valid.ok).toBe(true)
    if (!valid.ok) return

    const list = listWorkflows(profileId)
    expect(list.find((w) => w.id === invalidId)?.invalid).toBe(true)
    expect(list.find((w) => w.id === valid.id)?.invalid).toBeUndefined()
    fs.unlinkSync(path.join(dir, `${invalidId}.json`))
  })

  it('cloneWorkflow re-validates the source doc: a hand-corrupted file on disk (structurally invalid, schemaVersion 99, no isMainOutput node) is not propagated', () => {
    const dir = path.join(profileDir, 'workflows')
    fs.mkdirSync(dir, { recursive: true })
    const badPath = path.join(dir, 'bad-doc.json')
    fs.writeFileSync(
      badPath,
      JSON.stringify({
        id: 'bad-doc',
        name: 'Hand Corrupted',
        version: 1,
        schemaVersion: 99,
        nodes: [{ id: 'n1', type: 'input.context' }],
        edges: []
      })
    )

    const filesBefore = fs.readdirSync(dir)

    const result = cloneWorkflow(profileId, 'bad-doc')
    expect(result).toBeNull()

    const filesAfter = fs.readdirSync(dir)
    expect(filesAfter).toEqual(filesBefore)
  })

  it('deleteWorkflow removes the file (get returns null after)', () => {
    const created = createWorkflowFromDoc(profileId, minimalDoc({ name: 'To Delete' }))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(deleteWorkflow(profileId, created.id)).toBe(true)
    expect(getWorkflowById(profileId, created.id)).toBeNull()
  })

  it('importWorkflowFromFile: valid temp file -> ok + listed; invalid JSON -> not ok', () => {
    const tmpDir = fs.mkdtempSync(path.join(getAppDir(), 'wf-import-'))
    try {
      const validPath = path.join(tmpDir, 'valid.json')
      fs.writeFileSync(validPath, JSON.stringify(minimalDoc({ name: 'Imported Workflow' })))
      const result = importWorkflowFromFile(profileId, validPath)
      expect(result.ok).toBe(true)
      if (result.ok) {
        const list = listWorkflows(profileId)
        expect(list.some((w) => w.id === result.id)).toBe(true)
      }

      const invalidPath = path.join(tmpDir, 'invalid.json')
      fs.writeFileSync(invalidPath, '{ not valid json')
      const badResult = importWorkflowFromFile(profileId, invalidPath)
      expect(badResult.ok).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exportWorkflowToFile -> importWorkflowFromFile round-trips with a new id', () => {
    const created = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Exportable' }))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const tmpDir = fs.mkdtempSync(path.join(getAppDir(), 'wf-export-'))
    try {
      const exportPath = path.join(tmpDir, 'exported.json')
      expect(exportWorkflowToFile(profileId, created.id, exportPath)).toBe(true)

      const reimported = importWorkflowFromFile(profileId, exportPath)
      expect(reimported.ok).toBe(true)
      if (!reimported.ok) return
      expect(reimported.id).not.toBe(created.id)

      const doc = getWorkflowById(profileId, reimported.id)
      expect(doc!.name).toBe('Exportable')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exportWorkflowToFile returns false when the id does not resolve', () => {
    const tmpDir = fs.mkdtempSync(path.join(getAppDir(), 'wf-export-missing-'))
    try {
      const exportPath = path.join(tmpDir, 'missing.json')
      expect(exportWorkflowToFile(profileId, 'does-not-exist', exportPath)).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('save gate rejects an invalid node CONFIG with the node named (edit-time, not run-time)', () => {
    // mvu.set requires a non-empty path — the canonical "saves fine, fails at run" gap, now closed.
    const bad = minimalDoc({
      nodes: [
        { id: 'n1', type: 'input.context', isMainOutput: true },
        { id: 'setter', type: 'mvu.set', config: {} }
      ]
    })
    const result = createWorkflowFromDoc(profileId, bad)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('invalid node config')
    expect(result.error).toContain('setter (mvu.set)')
    expect(result.error).toContain('path')
  })

  it('save gate accepts the same doc once the config is valid', () => {
    const good = minimalDoc({
      nodes: [
        { id: 'n1', type: 'input.context', isMainOutput: true },
        { id: 'setter', type: 'mvu.set', config: { path: 'world.month', value: 1 } }
      ]
    })
    expect(createWorkflowFromDoc(profileId, good).ok).toBe(true)
  })

  it('save gate rejects a bad llm.sample failure config (wrong enum/type)', () => {
    const bad = minimalDoc({
      nodes: [
        { id: 'n1', type: 'input.context', isMainOutput: true },
        { id: 'llm-1', type: 'llm.sample', config: { validator: 'nope', retries: 'many' } }
      ]
    })
    const result = createWorkflowFromDoc(profileId, bad)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('llm-1 (llm.sample)')
  })
})

describe('workflowService selection + resolution', () => {
  const chatId = 'chat-1'
  const characterId = 'char-1'

  it('setGlobalWorkflow/setWorldWorkflow set + clear (null) round-trip via getSelection', () => {
    expect(getSelection(profileId)).toEqual({ global: null, worlds: {} })

    const created = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Selection Target' }))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    setGlobalWorkflow(profileId, created.id)
    expect(getSelection(profileId).global).toBe(created.id)

    setWorldWorkflow(profileId, characterId, created.id)
    expect(getSelection(profileId).worlds[characterId]).toBe(created.id)

    setGlobalWorkflow(profileId, null)
    expect(getSelection(profileId).global).toBeNull()

    setWorldWorkflow(profileId, characterId, null)
    expect(getSelection(profileId).worlds[characterId]).toBeUndefined()
  })

  it('resolution precedence: session wins over world wins over global wins over builtin', () => {
    const session = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Session Tier' }))
    const world = createWorkflowFromDoc(profileId, minimalDoc({ name: 'World Tier' }))
    const global = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Global Tier' }))
    expect(session.ok && world.ok && global.ok).toBe(true)
    if (!session.ok || !world.ok || !global.ok) return

    setWorldWorkflow(profileId, characterId, world.id)
    setGlobalWorkflow(profileId, global.id)
    mockChatService.getChat.mockReturnValue({ character_id: characterId })

    // global only
    mockChatService.getChatWorkflowId.mockReturnValue(null)
    setWorldWorkflow(profileId, characterId, null)
    expect(resolveWorkflowId(profileId, chatId)).toBe(global.id)

    // world beats global
    setWorldWorkflow(profileId, characterId, world.id)
    expect(resolveWorkflowId(profileId, chatId)).toBe(world.id)

    // session beats world + global
    mockChatService.getChatWorkflowId.mockReturnValue(session.id)
    expect(resolveWorkflowId(profileId, chatId)).toBe(session.id)

    // cleanup for subsequent tests
    setWorldWorkflow(profileId, characterId, null)
    setGlobalWorkflow(profileId, null)
  })

  it('builtin is the final fallback when nothing is selected', () => {
    mockChatService.getChatWorkflowId.mockReturnValue(null)
    mockChatService.getChat.mockReturnValue(null)
    expect(getSelection(profileId)).toEqual({ global: null, worlds: {} })
    expect(resolveWorkflowId(profileId, chatId)).toBe(BUILTIN_WORKFLOW_ID)
  })

  it('resolveWorkflowDoc returns { id: "default", doc: BUILTIN_DEFAULT_DOC } when nothing is selected', () => {
    mockChatService.getChatWorkflowId.mockReturnValue(null)
    mockChatService.getChat.mockReturnValue(null)
    const result = resolveWorkflowDoc(profileId, chatId)
    expect(result.id).toBe('default')
    // The builtin fallback is now the SQL-table memory doc (normalized to id 'default'), not the
    // old narrator-only DEFAULT_GRAPH.
    expect(result.doc).toEqual(BUILTIN_DEFAULT_DOC)
  })

  it('dangling id at each tier falls through to the next; all dangling -> default', () => {
    const world = createWorkflowFromDoc(profileId, minimalDoc({ name: 'World Fallback Target' }))
    expect(world.ok).toBe(true)
    if (!world.ok) return

    mockChatService.getChat.mockReturnValue({ character_id: characterId })
    setWorldWorkflow(profileId, characterId, world.id)
    setGlobalWorkflow(profileId, 'does-not-exist-global')

    // Session dangling -> falls through to world (which resolves).
    mockChatService.getChatWorkflowId.mockReturnValue('does-not-exist-session')
    expect(resolveWorkflowId(profileId, chatId)).toBe(world.id)

    // Session + world dangling -> falls through to global (also dangling) -> builtin.
    setWorldWorkflow(profileId, characterId, 'does-not-exist-world')
    expect(resolveWorkflowId(profileId, chatId)).toBe(BUILTIN_WORKFLOW_ID)

    setWorldWorkflow(profileId, characterId, null)
    setGlobalWorkflow(profileId, null)
  })

  it('invalid stored doc (hand-corrupted on disk) falls through to the next tier', () => {
    const dir = path.join(profileDir, 'workflows')
    fs.mkdirSync(dir, { recursive: true })
    const corruptId = 'corrupt-doc'
    fs.writeFileSync(
      path.join(dir, `${corruptId}.json`),
      JSON.stringify({
        id: corruptId,
        name: 'Hand Corrupted',
        version: 1,
        schemaVersion: 99,
        nodes: [{ id: 'n1', type: 'input.context' }],
        edges: []
      })
    )
    const world = createWorkflowFromDoc(profileId, minimalDoc({ name: 'World Beneath Corrupt' }))
    expect(world.ok).toBe(true)
    if (!world.ok) return

    mockChatService.getChat.mockReturnValue({ character_id: characterId })
    mockChatService.getChatWorkflowId.mockReturnValue(corruptId)
    setWorldWorkflow(profileId, characterId, world.id)

    expect(resolveWorkflowId(profileId, chatId)).toBe(world.id)

    setWorldWorkflow(profileId, characterId, null)
  })

  it('deleteWorkflow clears session (via removeWorkflowIdFromChats), global, and world selection entries', () => {
    const created = createWorkflowFromDoc(
      profileId,
      minimalDoc({ name: 'To Delete With Selection' })
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    setGlobalWorkflow(profileId, created.id)
    setWorldWorkflow(profileId, characterId, created.id)

    expect(deleteWorkflow(profileId, created.id)).toBe(true)

    const selection = getSelection(profileId)
    expect(selection.global).toBeNull()
    expect(selection.worlds[characterId]).toBeUndefined()
    expect(mockChatService.removeWorkflowIdFromChats).toHaveBeenCalledWith(profileId, created.id)
  })

  it('resolveWorkflowDoc falls through past a subgraph-kind doc to the next tier (sub-graph nodes v1 plan §5)', () => {
    const subgraph = createWorkflowFromDoc(profileId, {
      id: 'placeholder',
      name: 'A Sub-graph',
      version: 1,
      schemaVersion: 1,
      kind: 'subgraph',
      nodes: [
        { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      edges: [{ from: { node: 'bin', port: 'value' }, to: { node: 'bout', port: 'value' } }]
    })
    expect(subgraph.ok).toBe(true)
    if (!subgraph.ok) return

    const fallback = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Fallback Beneath Sub' }))
    expect(fallback.ok).toBe(true)
    if (!fallback.ok) return

    mockChatService.getChat.mockReturnValue(null)
    mockChatService.getChatWorkflowId.mockReturnValue(subgraph.id)
    setGlobalWorkflow(profileId, fallback.id)

    const result = resolveWorkflowDoc(profileId, chatId)
    expect(result.id).toBe(fallback.id)
    expect(result.doc.kind).not.toBe('subgraph')

    setGlobalWorkflow(profileId, null)
    mockChatService.getChatWorkflowId.mockReturnValue(null)
  })

  it('listWorkflows carries kind: "subgraph" for a saved sub-graph doc, and omits kind for a normal turn doc', () => {
    const subgraph = createWorkflowFromDoc(profileId, {
      id: 'placeholder',
      name: 'Listed Sub-graph',
      version: 1,
      schemaVersion: 1,
      kind: 'subgraph',
      nodes: [{ id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } }],
      edges: []
    })
    const turn = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Listed Turn Doc' }))
    expect(subgraph.ok && turn.ok).toBe(true)
    if (!subgraph.ok || !turn.ok) return

    const list = listWorkflows(profileId)
    expect(list.find((w) => w.id === subgraph.id)?.kind).toBe('subgraph')
    expect(list.find((w) => w.id === turn.id)?.kind).toBeUndefined()
  })

  it('save gate accepts a valid subgraph doc with no main-output node', () => {
    const created = createWorkflowFromDoc(profileId, minimalDoc({ name: 'To Become Sub-graph' }))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const subgraphDoc: WorkflowDoc = {
      id: created.id,
      name: 'To Become Sub-graph',
      version: 1,
      schemaVersion: 1,
      kind: 'subgraph',
      nodes: [
        { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } }
      ],
      edges: [{ from: { node: 'bin', port: 'value' }, to: { node: 'bout', port: 'value' } }]
    }
    const result = saveWorkflow(profileId, created.id, subgraphDoc)
    expect(result.ok).toBe(true)
  })

  it('createWorkflow(kind: "subgraph") saves a valid starter sub-graph doc (one boundary in/out, no edges)', () => {
    const result = createWorkflow(profileId, 'subgraph')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const doc = getWorkflowById(profileId, result.id)
    expect(doc?.kind).toBe('subgraph')
    expect(doc?.name).toBe('New Sub-graph')
    expect(doc?.nodes.map((n) => n.type).sort()).toEqual(['subgraph.input', 'subgraph.output'])
    expect(doc?.edges).toEqual([])
  })

  it('createWorkflow defaults to kind "subgraph" when no kind is given', () => {
    const result = createWorkflow(profileId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(getWorkflowById(profileId, result.id)?.kind).toBe('subgraph')
  })

  describe('sub-graph export bundling', () => {
    const subgraphDoc = (name: string, callId?: string): WorkflowDoc => ({
      id: 'placeholder',
      name,
      version: 1,
      schemaVersion: 1,
      kind: 'subgraph',
      nodes: [
        { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } },
        { id: 'bout', type: 'subgraph.output', config: { slot: 'out1' } },
        ...(callId
          ? [{ id: 'nested', type: 'subgraph.call', config: { workflow_id: callId } }]
          : [])
      ],
      edges: [{ from: { node: 'bin', port: 'value' }, to: { node: 'bout', port: 'value' } }]
    })

    const parentDoc = (name: string, callId: string): WorkflowDoc =>
      minimalDoc({
        name,
        nodes: [
          { id: 'n1', type: 'input.context', isMainOutput: true },
          { id: 'call', type: 'subgraph.call', config: { workflow_id: callId } }
        ]
      })

    it('exports a doc with subgraph.call refs as a bundle carrying the sub-graphs (transitively)', () => {
      const inner = createWorkflowFromDoc(profileId, subgraphDoc('Bundled Inner'))
      expect(inner.ok).toBe(true)
      if (!inner.ok) return
      const outer = createWorkflowFromDoc(profileId, subgraphDoc('Bundled Outer', inner.id))
      expect(outer.ok).toBe(true)
      if (!outer.ok) return
      const parent = createWorkflowFromDoc(profileId, parentDoc('Bundled Parent', outer.id))
      expect(parent.ok).toBe(true)
      if (!parent.ok) return

      const tmpDir = fs.mkdtempSync(path.join(getAppDir(), 'wf-bundle-'))
      try {
        const p = path.join(tmpDir, 'bundle.rptflow')
        expect(exportWorkflowToFile(profileId, parent.id, p)).toBe(true)
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
        expect(raw.format).toBe('rpt-workflow-bundle')
        expect(raw.main.name).toBe('Bundled Parent')
        expect(raw.subgraphs.map((s: WorkflowDoc) => s.name).sort()).toEqual([
          'Bundled Inner',
          'Bundled Outer'
        ])
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('exports a doc without subgraph refs as a plain doc (no bundle wrapper)', () => {
      const plain = createWorkflowFromDoc(profileId, minimalDoc({ name: 'No Refs' }))
      expect(plain.ok).toBe(true)
      if (!plain.ok) return
      const tmpDir = fs.mkdtempSync(path.join(getAppDir(), 'wf-plain-'))
      try {
        const p = path.join(tmpDir, 'plain.rptflow')
        expect(exportWorkflowToFile(profileId, plain.id, p)).toBe(true)
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
        expect(raw.format).toBeUndefined()
        expect(raw.name).toBe('No Refs')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('bundle round-trip: import creates fresh ids and rewrites subgraph.call references', () => {
      const inner = createWorkflowFromDoc(profileId, subgraphDoc('RT Inner'))
      expect(inner.ok).toBe(true)
      if (!inner.ok) return
      const parent = createWorkflowFromDoc(profileId, parentDoc('RT Parent', inner.id))
      expect(parent.ok).toBe(true)
      if (!parent.ok) return

      const tmpDir = fs.mkdtempSync(path.join(getAppDir(), 'wf-rt-'))
      try {
        const p = path.join(tmpDir, 'rt.rptflow')
        expect(exportWorkflowToFile(profileId, parent.id, p)).toBe(true)

        const imported = importWorkflowFromFile(profileId, p)
        expect(imported.ok).toBe(true)
        if (!imported.ok) return
        expect(imported.id).not.toBe(parent.id)

        const importedParent = getWorkflowById(profileId, imported.id)!
        const call = importedParent.nodes.find((n) => n.type === 'subgraph.call')!
        const newRef = (call.config as { workflow_id: string }).workflow_id
        expect(newRef).not.toBe(inner.id)
        const importedInner = getWorkflowById(profileId, newRef)
        expect(importedInner?.kind).toBe('subgraph')
        expect(importedInner?.name).toBe('RT Inner')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('a parent whose subgraph.loop references a sub-graph bundles and remaps on import', () => {
      const inner = createWorkflowFromDoc(profileId, subgraphDoc('Loop Inner'))
      expect(inner.ok).toBe(true)
      if (!inner.ok) return
      const parent = createWorkflowFromDoc(
        profileId,
        minimalDoc({
          name: 'Loop Parent',
          nodes: [
            { id: 'n1', type: 'input.context', isMainOutput: true },
            { id: 'loop', type: 'subgraph.loop', config: { workflow_id: inner.id } }
          ]
        })
      )
      expect(parent.ok).toBe(true)
      if (!parent.ok) return

      const tmpDir = fs.mkdtempSync(path.join(getAppDir(), 'wf-loop-'))
      try {
        const p = path.join(tmpDir, 'loop.rptflow')
        expect(exportWorkflowToFile(profileId, parent.id, p)).toBe(true)
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
        expect(raw.format).toBe('rpt-workflow-bundle')
        expect(raw.subgraphs.map((s: WorkflowDoc) => s.name)).toEqual(['Loop Inner'])

        const imported = importWorkflowFromFile(profileId, p)
        expect(imported.ok).toBe(true)
        if (!imported.ok) return
        const importedParent = getWorkflowById(profileId, imported.id)!
        const loop = importedParent.nodes.find((n) => n.type === 'subgraph.loop')!
        const newRef = (loop.config as { workflow_id: string }).workflow_id
        expect(newRef).not.toBe(inner.id)
        expect(getWorkflowById(profileId, newRef)?.name).toBe('Loop Inner')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('a bundle with one invalid sub-graph is rejected whole (no partial writes)', () => {
      const dir = path.join(profileDir, 'workflows')
      const before = fs.readdirSync(dir).length
      const tmpDir = fs.mkdtempSync(path.join(getAppDir(), 'wf-badbundle-'))
      try {
        const p = path.join(tmpDir, 'bad.rptflow')
        fs.writeFileSync(
          p,
          JSON.stringify({
            format: 'rpt-workflow-bundle',
            version: 1,
            main: parentDoc('Bad Bundle Parent', 'sub-1'),
            subgraphs: [
              {
                ...subgraphDoc('Broken Sub'),
                id: 'sub-1',
                nodes: [{ id: 'x', type: 'no.such.type' }],
                edges: []
              }
            ]
          })
        )
        const result = importWorkflowFromFile(profileId, p)
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error).toContain('Broken Sub')
        expect(fs.readdirSync(dir).length).toBe(before)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })

  it('save gate rejects a turn doc (kind absent) containing boundary nodes (BOUNDARY_IN_TURN)', () => {
    const created = createWorkflowFromDoc(profileId, minimalDoc({ name: 'Turn With Boundary' }))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const badDoc: WorkflowDoc = {
      id: created.id,
      name: 'Turn With Boundary',
      version: 1,
      schemaVersion: 1,
      nodes: [
        { id: 'n1', type: 'input.context', isMainOutput: true },
        { id: 'bin', type: 'subgraph.input', config: { slot: 'in1' } }
      ],
      edges: []
    }
    const result = saveWorkflow(profileId, created.id, badDoc)
    expect(result.ok).toBe(false)
  })

  // ── resolveEffectiveDoc + provider seam (agent-packs plan WP1.3, piece B) ──────────────────────
  describe('resolveEffectiveDoc', () => {
    afterEach(() => setEnabledFragmentsProvider()) // restore the default [] provider

    it('with the DEFAULT provider returns the narrator doc UNCHANGED (zero-packs identity)', () => {
      mockChatService.getChatWorkflowId.mockReturnValue(null)
      mockChatService.getChat.mockReturnValue(null)
      // Sanity: the narrator resolveWorkflowDoc would hand back.
      const narrator = resolveWorkflowDoc(profileId, chatId)
      const eff = resolveEffectiveDoc(profileId, chatId)
      expect(eff.id).toBe(narrator.id)
      // compose(narrator, []) returns the SAME object — we lean on that guarantee, not a re-clone.
      expect(eff.doc).toBe(narrator.doc)
      expect(eff.warnings).toEqual([])
    })

    it('composes the narrator with a registered provider fragment and surfaces its warnings', () => {
      mockChatService.getChatWorkflowId.mockReturnValue(null)
      mockChatService.getChat.mockReturnValue(null)

      const attachments: AttachmentDecl[] = [
        { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'blk', port: 'text' } }
      ]
      const fragment: ComposeFragment = {
        packId: 'p',
        gateOpen: true,
        doc: {
          id: 'frag',
          name: 'frag',
          version: 1,
          schemaVersion: 1,
          kind: 'fragment',
          nodes: [{ id: 'blk', type: 'text.template' }],
          edges: [],
          attachments
        }
      }
      setEnabledFragmentsProvider(() => [fragment])

      const eff = resolveEffectiveDoc(profileId, chatId)
      // The narrator id is preserved; the effective doc gained the pack's (prefixed) node.
      expect(eff.id).toBe(BUILTIN_WORKFLOW_ID)
      expect(eff.doc.nodes.some((n) => n.id === 'pack:p:blk')).toBe(true)
      // A clean single-pack rejoin composes with no warnings.
      expect(eff.warnings).toEqual([])
      // The composition metadata the engine consumes is present.
      expect((eff.doc.meta as { composition?: unknown }).composition).toBeDefined()
    })
  })
})
