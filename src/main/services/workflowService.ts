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
import { getChat, getChatWorkflowId, removeWorkflowIdFromChats } from './chatService'

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
const selectionPath = (profileId: string): string =>
  path.join(workflowsDir(profileId), '_selection.json')

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
    log(
      'error',
      `cloneWorkflow: source ${sourceId} failed validation, refusing to write`,
      result.error
    )
    return null
  }
  ensureWorkflowsDir(profileId)
  writeJsonSyncAtomic(workflowPath(profileId, id), result.doc)
  return { id, name: result.doc.name, description: result.doc.description }
}

/** Global/world default workflow selection (spec §12). Session override lives on `chats.workflow_id`
 *  (chatService); this sidecar only holds the global default and per-world (per-character) defaults. */
export interface WorkflowSelection {
  global: string | null
  worlds: Record<string, string>
}

/** Read the selection sidecar, defaulting to the empty selection when absent/unparseable. */
export const getSelection = (profileId: string): WorkflowSelection => {
  ensureWorkflowsDir(profileId)
  const data = readJsonSync<WorkflowSelection>(selectionPath(profileId))
  return {
    global: data?.global ?? null,
    worlds: data && typeof data.worlds === 'object' && data.worlds ? data.worlds : {}
  }
}

const writeSelection = (profileId: string, selection: WorkflowSelection): void => {
  ensureWorkflowsDir(profileId)
  writeJsonSyncAtomic(selectionPath(profileId), selection)
}

/** Set (or clear, with null) the global default workflow. */
export const setGlobalWorkflow = (profileId: string, id: string | null): void => {
  const selection = getSelection(profileId)
  writeSelection(profileId, { ...selection, global: id })
}

/** Set (or clear, with null) the per-world (per-character) default workflow. */
export const setWorldWorkflow = (
  profileId: string,
  characterId: string,
  id: string | null
): void => {
  const selection = getSelection(profileId)
  const worlds = { ...selection.worlds }
  if (id === null) delete worlds[characterId]
  else worlds[characterId] = id
  writeSelection(profileId, { ...selection, worlds })
}

/** Ordered tier candidates for a chat: session override, world default, global default —
 *  nulls/undefined filtered out. A missing chat just skips the world tier. */
const tierCandidates = (profileId: string, chatId: string): string[] => {
  const sessionId = getChatWorkflowId(profileId, chatId)
  const chat = getChat(profileId, chatId)
  const selection = getSelection(profileId)
  const worldId = chat ? (selection.worlds[chat.character_id] ?? null) : null
  const globalId = selection.global
  return [sessionId, worldId, globalId].filter((x): x is string => x != null)
}

/** Resolve the effective workflow for a chat: session -> world -> global -> builtin. A tier whose
 *  id no longer resolves to a valid, validating doc falls through to the next tier (never-block-
 *  a-turn) with a `log('error', ...)`. Final fallback is always the built-in default graph. */
export const resolveWorkflowDoc = (
  profileId: string,
  chatId: string
): { id: string; doc: WorkflowDoc } => {
  for (const id of tierCandidates(profileId, chatId)) {
    if (id === BUILTIN_WORKFLOW_ID) return { id: BUILTIN_WORKFLOW_ID, doc: DEFAULT_GRAPH }
    const raw = getWorkflowById(profileId, id)
    if (!raw) {
      log('error', `resolveWorkflowDoc: workflow ${id} not found, falling through`)
      continue
    }
    const result = validateWorkflowDoc(raw)
    if (!result.ok) {
      log(
        'error',
        `resolveWorkflowDoc: workflow ${id} failed validation, falling through`,
        result.error
      )
      continue
    }
    return { id, doc: result.doc }
  }
  return { id: BUILTIN_WORKFLOW_ID, doc: DEFAULT_GRAPH }
}

/** Resolve just the effective workflow id (delegates to resolveWorkflowDoc to share the fall-through). */
export const resolveWorkflowId = (profileId: string, chatId: string): string =>
  resolveWorkflowDoc(profileId, chatId).id

/** Unlinks the workflow's file and reports whether it existed. Never touches the builtin.
 *  Also clears the id out of every session override + the selection sidecar (global/world). */
export const deleteWorkflow = (profileId: string, id: string): boolean => {
  if (id === BUILTIN_WORKFLOW_ID) return false
  const p = workflowPath(profileId, id)
  if (!fs.existsSync(p)) return false
  fs.unlinkSync(p)
  removeWorkflowIdFromChats(profileId, id)
  const selection = getSelection(profileId)
  const worlds = { ...selection.worlds }
  let changed = false
  if (selection.global === id) changed = true
  for (const [characterId, workflowId] of Object.entries(worlds)) {
    if (workflowId === id) {
      delete worlds[characterId]
      changed = true
    }
  }
  if (changed)
    writeSelection(profileId, { global: selection.global === id ? null : selection.global, worlds })
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
