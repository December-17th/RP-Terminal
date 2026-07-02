import path from 'path'
import { getAppDir, ensureDir, readJsonSync } from './storageService'
import { WorkflowDoc } from '../../shared/workflow/types'
import { DEFAULT_GRAPH } from './nodes/builtin/defaultGraph'

/**
 * The workflow-doc file-read surface, extracted from workflowService so LEAF consumers (the
 * `subgraph.call` node) don't pull the whole workflowService module — that import would produce
 * a cycle, since workflowService imports the builtin node registry (for validation) and the
 * registry would now import subgraph.call, which needs `getWorkflowById`. Mirrors the
 * `generation/rawGenerate.ts` precedent (PR #35): workflowService re-exports everything here, so
 * its public surface is unchanged. See docs/superpowers/plans/2026-07-02-workflow-subgraph-nodes.md §4.
 */

export const BUILTIN_WORKFLOW_ID = 'default'

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
  if (id === BUILTIN_WORKFLOW_ID) return DEFAULT_GRAPH
  ensureWorkflowsDir(profileId)
  return readJsonSync<WorkflowDoc>(workflowPath(profileId, id))
}
