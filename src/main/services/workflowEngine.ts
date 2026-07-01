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
): Promise<{ fatal?: NodeError; aborted?: boolean }> {
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  const outgoing = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  for (const e of doc.edges) {
    incoming.get(e.to.node)?.push(e)
    outgoing.get(e.from.node)?.push(e)
  }

  for (const id of ids) {
    if (ctx.signal.aborted) {
      state.skipped.add(id)
      state.traces.push({ nodeId: id, status: 'skipped', phase })
      continue
    }

    const node = nodeById.get(id)!
    const impl = registry.get(node.type)!
    const ins = incoming.get(id) ?? []
    const outs = outgoing.get(id) ?? []

    if (ins.length > 0 && ins.every((e) => state.deadEdge.has(edgeKey(e)))) {
      state.skipped.add(id)
      for (const out of outs) state.deadEdge.add(edgeKey(out))
      state.traces.push({ nodeId: id, status: 'skipped', phase })
      continue
    }

    const inputs: Record<string, unknown> = {}
    for (const e of ins) {
      if (state.deadEdge.has(edgeKey(e))) continue
      inputs[e.to.port] = state.outputs.get(e.from.node)?.[e.from.port]
    }

    const started = Date.now()
    try {
      const result = (await impl.run(ctx, inputs)) ?? {}
      state.outputs.set(id, result.outputs ?? {})
      state.traces.push({ nodeId: id, status: 'ran', phase, ms: Date.now() - started })
      const fired = new Set(result.signals ?? [])
      for (const out of outs) {
        const port = impl.outputs.find((p) => p.name === out.from.port)
        if (port?.type === 'Signal' && !fired.has(out.from.port)) state.deadEdge.add(edgeKey(out))
      }
    } catch (err) {
      const nodeError: NodeError = {
        kind: 'A',
        message: err instanceof Error ? err.message : String(err),
        nodeId: id,
        attempts: 1
      }
      const errorPort = impl.outputs.find((p) => p.name === 'error' && p.type === 'Error')
      const errorEdges = outs.filter((o) => o.from.port === 'error')
      const wired = !!errorPort && errorEdges.length > 0
      state.traces.push({
        nodeId: id,
        status: 'failed',
        phase,
        error: nodeError,
        ms: Date.now() - started
      })
      if (wired) {
        // Deliver the error on the error port; kill the normal (non-error) branch.
        state.outputs.set(id, { error: nodeError })
        for (const out of outs) if (out.from.port !== 'error') state.deadEdge.add(edgeKey(out))
      } else {
        // Kill all outputs; a pre-phase unwired failure is fatal, a post-phase one fails open.
        for (const out of outs) state.deadEdge.add(edgeKey(out))
        if (phase === 'pre') return { fatal: nodeError }
      }
    }
  }
  return { aborted: ctx.signal.aborted }
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

  const pre = await runNodes(
    order.filter((id) => preIds.has(id)),
    doc,
    registry,
    ctx,
    state,
    'pre'
  )
  if (pre.fatal) {
    return {
      ok: false,
      aborted: false,
      traces: state.traces,
      outputs: state.outputs,
      error: pre.fatal
    }
  }
  if (pre.aborted) {
    // mark any post nodes as skipped so the trace is complete, then bail without onResponseReady
    for (const id of order.filter((id) => postIds.has(id))) {
      state.traces.push({ nodeId: id, status: 'skipped', phase: 'post' })
    }
    return { ok: false, aborted: true, traces: state.traces, outputs: state.outputs }
  }
  ctx.onResponseReady?.()
  const post = await runNodes(
    order.filter((id) => postIds.has(id)),
    doc,
    registry,
    ctx,
    state,
    'post'
  )

  return {
    ok: !post.aborted,
    aborted: !!post.aborted,
    traces: state.traces,
    outputs: state.outputs
  }
}
