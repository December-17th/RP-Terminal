import { WorkflowDoc, Edge } from '../../shared/workflow/types'
import { validateWorkflow, ValidationError } from '../../shared/workflow/validate'
import { topoOrder } from '../../shared/workflow/graph'
import { NodeRegistry } from './nodes/registry'
import { RunContext, NodeError } from './nodes/types'

export class WorkflowValidationError extends Error {
  errors: ValidationError[]
  constructor(errors: ValidationError[]) {
    super(`invalid workflow: ${errors.map((e) => e.code).join(', ')}`)
    this.name = 'WorkflowValidationError'
    this.errors = errors
  }
}

export interface NodeTrace {
  nodeId: string
  status: 'ran' | 'skipped' | 'failed'
  phase: 'pre' | 'post'
  error?: NodeError
  ms?: number
}

export interface RunResult {
  ok: boolean
  aborted: boolean
  traces: NodeTrace[]
  outputs: Map<string, Record<string, unknown>>
  error?: NodeError
}

const edgeKey = (e: Edge): string => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`

/** Mutable state shared across the run passes. */
interface ExecState {
  outputs: Map<string, Record<string, unknown>>
  deadEdge: Set<string>
  skipped: Set<string>
  traces: NodeTrace[]
}

/** Run a list of node ids (already in topological order) against the registry, mutating `state`.
 *  Handles input wiring, branch-prune, and per-node output/signal bookkeeping. */
async function runNodes(
  ids: string[],
  doc: WorkflowDoc,
  registry: NodeRegistry,
  ctx: RunContext,
  state: ExecState,
  phase: 'pre' | 'post'
): Promise<void> {
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  const outgoing = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  for (const e of doc.edges) {
    incoming.get(e.to.node)?.push(e)
    outgoing.get(e.from.node)?.push(e)
  }

  for (const id of ids) {
    const node = nodeById.get(id)!
    const impl = registry.get(node.type)!
    const ins = incoming.get(id) ?? []

    // Branch-prune: a node with ≥1 incoming edge, all dead, is skipped; its outgoing edges die too.
    if (ins.length > 0 && ins.every((e) => state.deadEdge.has(edgeKey(e)))) {
      state.skipped.add(id)
      for (const out of outgoing.get(id) ?? []) state.deadEdge.add(edgeKey(out))
      state.traces.push({ nodeId: id, status: 'skipped', phase })
      continue
    }

    // Gather inputs from live incoming edges (last edge into a port wins).
    const inputs: Record<string, unknown> = {}
    for (const e of ins) {
      if (state.deadEdge.has(edgeKey(e))) continue
      inputs[e.to.port] = state.outputs.get(e.from.node)?.[e.from.port]
    }

    const started = Date.now()
    const result = (await impl.run(ctx, inputs)) ?? {}
    state.outputs.set(id, result.outputs ?? {})
    state.traces.push({ nodeId: id, status: 'ran', phase, ms: Date.now() - started })

    // Kill edges from Signal output ports that did not fire (branch selection).
    const fired = new Set(result.signals ?? [])
    for (const out of outgoing.get(id) ?? []) {
      const port = impl.outputs.find((p) => p.name === out.from.port)
      if (port?.type === 'Signal' && !fired.has(out.from.port)) state.deadEdge.add(edgeKey(out))
    }
  }
}

/** Pre-phase = the main-output node and every node that can reach it (its ancestors). Everything
 *  else (downstream + independent side branches) is post-phase — async, off the hot path (spec §5). */
function computePhases(doc: WorkflowDoc): { preIds: Set<string>; postIds: Set<string> } {
  const main = doc.nodes.find((n) => n.isMainOutput)!.id
  const revAdj = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]))
  for (const e of doc.edges) revAdj.get(e.to.node)?.push(e.from.node)

  const preIds = new Set<string>([main])
  const stack = [main]
  while (stack.length) {
    const cur = stack.pop()!
    for (const parent of revAdj.get(cur) ?? []) {
      if (!preIds.has(parent)) {
        preIds.add(parent)
        stack.push(parent)
      }
    }
  }
  const postIds = new Set(doc.nodes.map((n) => n.id).filter((id) => !preIds.has(id)))
  return { preIds, postIds }
}

/** Execute a workflow. Runs the main-output node and its ancestors in a pre-response phase,
 *  fires onResponseReady, then runs the remaining nodes in a post-response phase (spec §5). */
export async function runWorkflow(
  doc: WorkflowDoc,
  registry: NodeRegistry,
  ctx: RunContext
): Promise<RunResult> {
  const v = validateWorkflow(doc, registry.descriptors())
  if (!v.ok) throw new WorkflowValidationError(v.errors)

  const state: ExecState = {
    outputs: new Map(),
    deadEdge: new Set(),
    skipped: new Set(),
    traces: []
  }

  const order = topoOrder(doc)
  const { preIds, postIds } = computePhases(doc)

  await runNodes(
    order.filter((id) => preIds.has(id)),
    doc,
    registry,
    ctx,
    state,
    'pre'
  )
  ctx.onResponseReady?.()
  await runNodes(
    order.filter((id) => postIds.has(id)),
    doc,
    registry,
    ctx,
    state,
    'post'
  )

  return { ok: true, aborted: false, traces: state.traces, outputs: state.outputs }
}
