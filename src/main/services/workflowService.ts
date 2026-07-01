import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { parseWorkflowDoc } from '../../shared/workflow/docSchema'
import { validateWorkflow } from '../../shared/workflow/validate'
import { WorkflowDoc } from '../../shared/workflow/types'
import { builtinRegistry } from './nodes/builtin'
import { DEFAULT_GRAPH } from './nodes/builtin/defaultGraph'
import { log } from './logService'

export const BUILTIN_WORKFLOW_ID = 'default'

export interface WorkflowSummary {
  id: string
  name: string
  description?: string
  builtin?: boolean
}

export type WorkflowWriteResult = { ok: true; id: string } | { ok: false; error: string }

/** Structural (docSchema) + graph (validate.ts) validation gate — spec §12. */
export const validateWorkflowDoc = (
  raw: unknown
): { ok: true; doc: WorkflowDoc } | { ok: false; error: string } => {
  const structural = parseWorkflowDoc(raw)
  if (!structural.ok) return structural
  const v = validateWorkflow(structural.doc, builtinRegistry.descriptors())
  if (!v.ok) return { ok: false, error: v.errors.map((e) => e.message).join('; ') }
  return { ok: true, doc: structural.doc }
}

const workflowsDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'workflows')
const workflowPath = (profileId: string, id: string): string =>
  path.join(workflowsDir(profileId), `${id}.json`)

const ensureWorkflowsDir = (profileId: string): string => {
  const dir = workflowsDir(profileId)
  ensureDir(dir)
  return dir
}

export const listWorkflows = (profileId: string): WorkflowSummary[] => {
  const dir = ensureWorkflowsDir(profileId)
  const out: WorkflowSummary[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const id = file.replace(/\.json$/, '')
    const data = readJsonSync<WorkflowDoc>(path.join(dir, file))
    if (data)
      out.push({ id, name: data.name || 'Untitled Workflow', description: data.description })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return [
    {
      id: BUILTIN_WORKFLOW_ID,
      name: DEFAULT_GRAPH.name,
      description: DEFAULT_GRAPH.description,
      builtin: true
    },
    ...out
  ]
}

export const getWorkflowById = (profileId: string, id: string): WorkflowDoc | null => {
  if (id === BUILTIN_WORKFLOW_ID) return DEFAULT_GRAPH
  ensureWorkflowsDir(profileId)
  return readJsonSync<WorkflowDoc>(workflowPath(profileId, id))
}

export const saveWorkflow = (profileId: string, id: string, raw: unknown): WorkflowWriteResult => {
  if (id === BUILTIN_WORKFLOW_ID)
    return { ok: false, error: 'the built-in workflow cannot be modified; clone it first' }
  const result = validateWorkflowDoc(raw)
  if (!result.ok) return result
  ensureWorkflowsDir(profileId)
  writeJsonSyncAtomic(workflowPath(profileId, id), result.doc)
  return { ok: true, id }
}

export const createWorkflowFromDoc = (profileId: string, raw: unknown): WorkflowWriteResult => {
  const id = randomUUID()
  const withId = raw && typeof raw === 'object' ? { ...(raw as object), id } : raw
  const result = validateWorkflowDoc(withId)
  if (!result.ok) return result
  ensureWorkflowsDir(profileId)
  writeJsonSyncAtomic(workflowPath(profileId, id), result.doc)
  return { ok: true, id }
}

/** Clones a workflow doc under a fresh id. Re-validates the assembled clone before writing —
 *  a source doc that was hand-corrupted on disk (bypassing our own write paths) must not be
 *  faithfully re-propagated; invalid docs are NEVER written, clone included. */
export const cloneWorkflow = (profileId: string, sourceId: string): WorkflowSummary | null => {
  const source = getWorkflowById(profileId, sourceId)
  if (!source) return null
  const id = randomUUID()
  const clone: WorkflowDoc = {
    ...structuredClone(source),
    id,
    name: `${source.name} (copy)`
  }
  const result = validateWorkflowDoc(clone)
  if (!result.ok) {
    log('error', `cloneWorkflow: source ${sourceId} failed validation, refusing to write`, result.error)
    return null
  }
  ensureWorkflowsDir(profileId)
  writeJsonSyncAtomic(workflowPath(profileId, id), result.doc)
  return { id, name: result.doc.name, description: result.doc.description }
}

/** Unlinks the workflow's file and reports whether it existed. Never touches the builtin.
 *  Selection-sidecar cleanup is added in Task 3. */
export const deleteWorkflow = (profileId: string, id: string): boolean => {
  if (id === BUILTIN_WORKFLOW_ID) return false
  const p = workflowPath(profileId, id)
  if (!fs.existsSync(p)) return false
  fs.unlinkSync(p)
  return true
}

export const importWorkflowFromFile = (
  profileId: string,
  filePath: string
): WorkflowWriteResult => {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` }
  }
  return createWorkflowFromDoc(profileId, raw)
}

export const exportWorkflowToFile = (profileId: string, id: string, filePath: string): boolean => {
  const doc = getWorkflowById(profileId, id)
  if (!doc) return false
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf-8')
  return true
}
