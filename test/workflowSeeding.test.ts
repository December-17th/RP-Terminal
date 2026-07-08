import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

// Lazy default-memory seeding (agent-memory-ux WP-C; plan §0.3). Uses the REAL workflowService
// against the vitest temp data root (workflowService.test.ts's idiom: fresh per-test profile ids,
// files cleaned after). chatService is mocked the same way that suite mocks it.

const mockChatService = vi.hoisted(() => ({
  getChatWorkflowId: vi.fn<() => string | null>(() => null),
  getChat: vi.fn<() => { character_id: string } | null>(() => null),
  setChatWorkflowId: vi.fn(),
  removeWorkflowIdFromChats: vi.fn()
}))
vi.mock('../src/main/services/chatService', () => mockChatService)

import {
  listWorkflows,
  getWorkflowById,
  createWorkflowFromDoc,
  deleteWorkflow,
  getSelection,
  setGlobalWorkflow,
  resetMemorySeedGuardForTest,
  setMemorySeedingEnabled
} from '../src/main/services/workflowService'
import { getAppDir } from '../src/main/services/storageService'
import { WorkflowDoc } from '../src/shared/workflow/types'
import {
  buildDefaultMemoryDoc,
  DEFAULT_MEMORY_SEED_MARKER,
  DEFAULT_MEMORY_SEED_MARKER_V2
} from '../src/main/services/nodes/builtin/defaultMemoryTemplate'

const madeProfiles: string[] = []
const freshProfile = (): string => {
  const id = `wf-seed-${randomUUID()}`
  madeProfiles.push(id)
  return id
}
afterAll(() => {
  for (const id of madeProfiles)
    fs.rmSync(path.join(getAppDir(), 'profiles', id), { recursive: true, force: true })
})

beforeEach(() => {
  setMemorySeedingEnabled(true)
  resetMemorySeedGuardForTest()
  mockChatService.getChatWorkflowId.mockReset().mockReturnValue(null)
  mockChatService.getChat.mockReset().mockReturnValue(null)
})

/** The seeded doc's summary in a list, identified by reading the doc's meta marker (v2 = the current
 *  memory.maintain single-node default; the seeder no longer emits v1). */
const findSeeded = (profileId: string): { id: string; doc: WorkflowDoc } | null => {
  const dir = path.join(getAppDir(), 'profiles', profileId, 'workflows')
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as WorkflowDoc
    if ((doc.meta as Record<string, unknown> | undefined)?.seeded === DEFAULT_MEMORY_SEED_MARKER_V2)
      return { id: file.replace(/\.json$/, ''), doc }
  }
  return null
}

const minimalDoc = (overrides: Partial<WorkflowDoc> = {}): WorkflowDoc => ({
  id: 'placeholder',
  name: 'My Workflow',
  version: 1,
  schemaVersion: 1,
  nodes: [{ id: 'n1', type: 'input.context', isMainOutput: true }],
  edges: [],
  ...overrides
})

describe('default-memory seeding (WP-C, plan §0.3)', () => {
  it('a fresh profile gets an editable "Default" doc, selected globally, on first list', () => {
    const profileId = freshProfile()
    const list = listWorkflows(profileId)

    const seeded = findSeeded(profileId)
    expect(seeded).not.toBeNull()
    expect(seeded!.doc.name).toBe('Default')
    // Listed as an ordinary (non-builtin, valid) doc.
    const row = list.find((w) => w.id === seeded!.id)
    expect(row).toBeDefined()
    expect(row!.builtin).toBeUndefined()
    expect(row!.invalid).toBeUndefined()
    // Selected globally (nothing was selected before).
    expect(getSelection(profileId).global).toBe(seeded!.id)
    // Editable: it is a real file doc, retrievable by id.
    expect(getWorkflowById(profileId, seeded!.id)?.name).toBe('Default')
  })

  it('is idempotent: repeated lists (and re-evaluations across the process guard) seed once', () => {
    const profileId = freshProfile()
    listWorkflows(profileId)
    listWorkflows(profileId)
    resetMemorySeedGuardForTest() // simulate a fresh process — the on-disk marker must hold
    listWorkflows(profileId)

    const dir = path.join(getAppDir(), 'profiles', profileId, 'workflows')
    const docs = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    expect(docs).toHaveLength(1)
  })

  it('a renamed seeded doc still counts (marker-based idempotence, not name-based)', () => {
    const profileId = freshProfile()
    listWorkflows(profileId)
    const seeded = findSeeded(profileId)!
    // Rename on disk (the marker in meta survives).
    const p = path.join(getAppDir(), 'profiles', profileId, 'workflows', `${seeded.id}.json`)
    const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as WorkflowDoc
    doc.name = 'My Renamed Memory'
    fs.writeFileSync(p, JSON.stringify(doc), 'utf-8')

    resetMemorySeedGuardForTest()
    listWorkflows(profileId)
    const dir = path.join(getAppDir(), 'profiles', profileId, 'workflows')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))).toHaveLength(1)
  })

  it('does NOT stomp an existing global selection', () => {
    const profileId = freshProfile()
    setMemorySeedingEnabled(false) // create the user's doc without triggering the seed first
    const created = createWorkflowFromDoc(profileId, minimalDoc())
    if (!created.ok) throw new Error(created.error)
    setGlobalWorkflow(profileId, created.id)
    setMemorySeedingEnabled(true)

    listWorkflows(profileId)
    expect(findSeeded(profileId)).not.toBeNull() // still seeded (doc has no memory nodes)...
    expect(getSelection(profileId).global).toBe(created.id) // ...but the user's choice stands
  })

  it('does NOT seed a profile whose user docs already reference memory (table.apply / agent.llm / memory.maintain)', () => {
    for (const type of ['table.apply', 'agent.llm', 'memory.maintain']) {
      const profileId = freshProfile()
      setMemorySeedingEnabled(false)
      const created = createWorkflowFromDoc(
        profileId,
        minimalDoc({
          nodes: [
            { id: 'n1', type: 'input.context', isMainOutput: true },
            { id: 'mem', type, config: type === 'table.apply' ? {} : { messages: [] } }
          ]
        })
      )
      if (!created.ok) throw new Error(created.error)
      setMemorySeedingEnabled(true)

      listWorkflows(profileId)
      expect(findSeeded(profileId)).toBeNull()
      expect(getSelection(profileId).global).toBeNull()
    }
  })

  it('deleting the seeded doc tombstones the marker — never re-seeded, selection cleared', () => {
    const profileId = freshProfile()
    listWorkflows(profileId)
    const seeded = findSeeded(profileId)!

    expect(deleteWorkflow(profileId, seeded.id)).toBe(true)
    // Tombstone recorded in the sidecar (v2 marker — deleteWorkflow is generic over meta.seeded).
    expect(getSelection(profileId).seededTombstones).toEqual([DEFAULT_MEMORY_SEED_MARKER_V2])
    // The doc's global selection was cleared by the delete.
    expect(getSelection(profileId).global).toBeNull()

    // Simulate a fresh process: the tombstone (not the in-process guard) must block the re-seed.
    resetMemorySeedGuardForTest()
    listWorkflows(profileId)
    expect(findSeeded(profileId)).toBeNull()
    expect(getSelection(profileId).global).toBeNull()
  })

  it('deleting a NON-seeded doc leaves no tombstone', () => {
    const profileId = freshProfile()
    setMemorySeedingEnabled(false)
    const created = createWorkflowFromDoc(profileId, minimalDoc())
    if (!created.ok) throw new Error(created.error)
    expect(deleteWorkflow(profileId, created.id)).toBe(true)
    expect(getSelection(profileId).seededTombstones).toBeUndefined()
  })

  it('the tombstone survives later selection writes (setGlobalWorkflow spreads the sidecar)', () => {
    const profileId = freshProfile()
    listWorkflows(profileId)
    const seeded = findSeeded(profileId)!
    deleteWorkflow(profileId, seeded.id)

    setGlobalWorkflow(profileId, 'some-other-id')
    expect(getSelection(profileId).seededTombstones).toEqual([DEFAULT_MEMORY_SEED_MARKER_V2])
    expect(getSelection(profileId).global).toBe('some-other-id')
  })
})

describe('default-memory v1 → v2 supersession (memory.maintain plan WP3, auto-replace)', () => {
  it('replaces a live v1 default doc with v2: v1 deleted + tombstoned, v2 seeded, global repointed', () => {
    const profileId = freshProfile()
    setMemorySeedingEnabled(false) // plant a v1 doc without the seeder firing first
    const v1 = createWorkflowFromDoc(profileId, buildDefaultMemoryDoc())
    if (!v1.ok) throw new Error(v1.error)
    setGlobalWorkflow(profileId, v1.id)
    setMemorySeedingEnabled(true)

    listWorkflows(profileId)

    // v1 gone, v2 present, exactly one default doc on disk.
    expect(getWorkflowById(profileId, v1.id)).toBeFalsy()
    const seeded = findSeeded(profileId)
    expect(seeded).not.toBeNull()
    expect(seeded!.id).not.toBe(v1.id)
    const dir = path.join(getAppDir(), 'profiles', profileId, 'workflows')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))).toHaveLength(1)
    // v1 tombstoned (never re-seeds); global repointed from the deleted v1 to v2.
    expect(getSelection(profileId).seededTombstones).toContain(DEFAULT_MEMORY_SEED_MARKER)
    expect(getSelection(profileId).global).toBe(seeded!.id)
  })

  it('does NOT resurrect a deliberately deleted v1 default as v2 (v1 tombstone wins)', () => {
    const profileId = freshProfile()
    setMemorySeedingEnabled(false)
    const v1 = createWorkflowFromDoc(profileId, buildDefaultMemoryDoc())
    if (!v1.ok) throw new Error(v1.error)
    setMemorySeedingEnabled(true)
    deleteWorkflow(profileId, v1.id) // tombstones default-memory-v1

    resetMemorySeedGuardForTest()
    listWorkflows(profileId)

    // No default doc reseeded — the deletion is respected across "restarts".
    expect(findSeeded(profileId)).toBeNull()
    expect(getSelection(profileId).global).toBeNull()
  })
})
