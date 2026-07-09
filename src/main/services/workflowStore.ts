import path from 'path'
import { getAppDir, ensureDir, readJsonSync } from './storageService'
import { WorkflowDoc } from '../../shared/workflow/types'
import { buildDefaultMemoryDocV2 } from './nodes/builtin/defaultMemoryTemplate'

/**
 * The workflow-doc file-read surface, extracted from workflowService so LEAF consumers (the
 * `subgraph.call` node) don't pull the whole workflowService module — that import would produce
 * a cycle, since workflowService imports the builtin node registry (for validation) and the
 * registry would now import subgraph.call, which needs `getWorkflowById`. Mirrors the
 * `generation/rawGenerate.ts` precedent (PR #35): workflowService re-exports everything here, so
 * its public surface is unchanged. See docs/superpowers/plans/2026-07-02-workflow-subgraph-nodes.md §4.
 */

export const BUILTIN_WORKFLOW_ID = 'default'

/**
 * The invisible built-in fallback doc (the memory-default refactor). The narrator-only `DEFAULT_GRAPH`
 * is gone; the SQL-table memory template IS the builtin now. Normalized from the v2 template so it can
 * serve as a read-only builtin: its id is the well-known `BUILTIN_WORKFLOW_ID` ('default'), and the
 * `meta.seeded` marker is STRIPPED (`meta: {}`) — a read-only builtin must not carry a seed marker, or
 * the seeder's marker scan would mistake this fallback for an already-seeded profile doc. Keeps
 * `name: 'Default'`. This is NEVER surfaced in listWorkflows (a pure fallback); it only resolves when
 * a chat references id 'default' or every selection tier falls through. A turn run of it is
 * trace-equivalent to the narrator spine (the memory group is `isTrigger`-gated out of the turn phase).
 */
export const BUILTIN_DEFAULT_DOC: WorkflowDoc = {
  ...buildDefaultMemoryDocV2(),
  id: BUILTIN_WORKFLOW_ID,
  meta: {}
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

/** Read a workflow doc by id (the builtin default graph, or a profile's saved file). Returns
 *  null when the id doesn't resolve — callers decide how to handle that (fall-through, error). */
export const getWorkflowById = (profileId: string, id: string): WorkflowDoc | null => {
  if (id === BUILTIN_WORKFLOW_ID) return BUILTIN_DEFAULT_DOC
  ensureWorkflowsDir(profileId)
  return readJsonSync<WorkflowDoc>(workflowPath(profileId, id))
}
