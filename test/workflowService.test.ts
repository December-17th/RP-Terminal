import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  BUILTIN_WORKFLOW_ID,
  listWorkflows,
  getWorkflowById,
  saveWorkflow,
  createWorkflowFromDoc,
  cloneWorkflow,
  deleteWorkflow,
  importWorkflowFromFile,
  exportWorkflowToFile
} from '../src/main/services/workflowService'
import { getAppDir } from '../src/main/services/storageService'
import { WorkflowDoc } from '../src/shared/workflow/types'

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

describe('workflowService', () => {
  it('listWorkflows has the builtin first even with no user files', () => {
    const list = listWorkflows(profileId)
    expect(list[0]).toMatchObject({ id: BUILTIN_WORKFLOW_ID, builtin: true })
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
    expect(clone!.name).toBe('Default Generation (copy)')

    const doc = getWorkflowById(profileId, clone!.id)
    expect(doc).not.toBeNull()
    expect(doc!.id).toBe(clone!.id)
    expect(doc!.nodes.some((n) => n.id === 'ctx')).toBe(true)
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
})
