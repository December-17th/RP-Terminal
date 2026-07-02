import { WorkflowDoc, Edge, NodeDescriptor } from '../../shared/workflow/types'
import { validateWorkflow, ValidationError } from '../../shared/workflow/validate'
import { topoOrder } from '../../shared/workflow/graph'
import { NodeRegistry } from './nodes/registry'
import { RunContext, NodeError, NodeRunFailure } from './nodes/types'

/**
 * The text a node's opt-in output panel shows (spec D4): its Text-typed output ports joined
 * (the natural payload — a side LLM's reply, a template's render); when the node has none,
 * a JSON rendering of the first data port (Context and Signal ports carry nothing displayable).
 * Pure + exported for tests.
 */
export const panelTextOf = (
  outputs: Record<string, unknown>,
  descriptor: NodeDescriptor
): string => {
  const texts: string[] = []
  for (const port of descriptor.outputs) {
    if (port.type !== 'Text') continue
    const v = outputs[port.name]
    if (typeof v === 'string' && v) texts.push(v)
  }
  if (texts.length) return texts.join('\n\n')
  for (const port of descriptor.outputs) {
    if (port.type === 'Context' || port.type === 'Signal') continue
    const v = outputs[port.name]
    if (v === undefined) continue
    try {
      return JSON.stringify(v, null, 2) ?? ''
    } catch {
      return ''
    }
  }
  return ''
}

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
    const outs = outgoing.get(id) ?? []

    if (ctx.signal.aborted) {
      for (const out of outs) state.deadEdge.add(edgeKey(out))
      state.traces.push({ nodeId: id, status: 'skipped', phase })
      continue
    }

    const node = nodeById.get(id)!
    const impl = registry.get(node.type)!
    const ins = incoming.get(id) ?? []

    // Branch-prune: signal firing is only known after a node runs, so which edges are dead
    // can't be computed upfront — pruning is interleaved with execution in this single forward
    // topo pass, unlike graph.ts's prunedNodes(), which takes a static inactive-edge set.
    // Two prune rules (spec §5): every incoming edge dead (nothing can feed the node), OR the
    // node is signal-GATED — it has incoming Signal-typed edges and none of them fired.
    const allDead = ins.length > 0 && ins.every((e) => state.deadEdge.has(edgeKey(e)))
    const signalIns = ins.filter((e) => {
      const src = nodeById.get(e.from.node)
      const srcImpl = src && registry.get(src.type)
      return srcImpl?.outputs.find((p) => p.name === e.from.port)?.type === 'Signal'
    })
    const gatedOff = signalIns.length > 0 && signalIns.every((e) => state.deadEdge.has(edgeKey(e)))
    if (allDead || gatedOff) {
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
      const config = (
        impl.configSchema ? impl.configSchema.parse(node.config ?? {}) : (node.config ?? {})
      ) as Record<string, unknown>
      const result = (await impl.run(ctx, inputs, { id, config })) ?? {}
      state.outputs.set(id, result.outputs ?? {})
      state.traces.push({ nodeId: id, status: 'ran', phase, ms: Date.now() - started })
      // Opt-in output panel (spec D4): a node with panel.show fills its collapsible chat panel
      // on completion (only the main output streams live — spec §5).
      if (node.panel?.show) {
        const text = panelTextOf(result.outputs ?? {}, impl)
        if (text) ctx.emitPanel(id, text)
      }
      const fired = new Set(result.signals ?? [])
      for (const out of outs) {
        const port = impl.outputs.find((p) => p.name === out.from.port)
        if (port?.type === 'Signal' && !fired.has(out.from.port)) state.deadEdge.add(edgeKey(out))
      }
    } catch (err) {
      // A NodeRunFailure carries the failure class + attempt count (spec §10); a plain throw
      // stays the class-A / single-attempt default.
      const f = err instanceof NodeRunFailure ? err : undefined
      const nodeError: NodeError = {
        kind: f?.kind ?? 'A',
        message: err instanceof Error ? err.message : String(err),
        ...(f?.code !== undefined ? { code: f.code } : {}),
        nodeId: id,
        attempts: f?.attempts ?? 1
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
  // Defense-in-depth (sub-graph nodes v1 plan §5): resolveWorkflowDoc is the load-bearing guard
  // that keeps a subgraph-kind doc out of here, but a future/alternate caller reaching runWorkflow
  // directly with one would otherwise hit computePhases' non-null main-output assertion as a raw,
  // cryptic TypeError — fail loudly instead.
  if (doc.kind === 'subgraph')
    throw new Error(
      `runWorkflow: doc "${doc.id}" is a sub-graph doc (kind: 'subgraph') and cannot be run directly — invoke it via a subgraph.call node instead`
    )

  const v = validateWorkflow(doc, registry.descriptors())
  if (!v.ok) throw new WorkflowValidationError(v.errors)

  const state: ExecState = {
    outputs: new Map(),
    deadEdge: new Set(),
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
  ctx.onResponseReady?.(state.outputs)
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

export interface SubgraphRunResult {
  outputs: Record<string, unknown>
  fatal?: NodeError
  aborted: boolean
  traces: NodeTrace[]
}

/** Run a 'subgraph'-kind doc as a self-contained unit inside a `subgraph.call` node's run()
 *  (sub-graph nodes v1 plan §4) — built on the EXISTING `runNodes` loop (not forked): one single
 *  pass over the whole doc's topo order with `phase: 'pre'` and a fresh ExecState. `seeds` feeds
 *  `ctx.subgraphSeeds` (read by `subgraph.input` nodes); outputs are collected via
 *  `ctx.subgraphCollect` (written by `subgraph.output` nodes) into the returned `outputs` map.
 *  There is no pre/post phase split and no `onResponseReady` here — a sub-graph run happens
 *  entirely within its wrapper node's own phase in the PARENT graph, so signal gating, config
 *  parsing, and error-port routing inside the sub-graph all come free from `runNodes`. */
export async function runSubgraph(
  doc: WorkflowDoc,
  registry: NodeRegistry,
  parentCtx: RunContext,
  seeds: Record<string, unknown>
): Promise<SubgraphRunResult> {
  const outputs: Record<string, unknown> = {}
  const ctx: RunContext = {
    ...parentCtx,
    subgraphSeeds: seeds,
    subgraphCollect: (slot, value) => {
      outputs[slot] = value
    }
  }

  const state: ExecState = {
    outputs: new Map(),
    deadEdge: new Set(),
    traces: []
  }

  const order = topoOrder(doc)
  const result = await runNodes(order, doc, registry, ctx, state, 'pre')

  return {
    outputs,
    ...(result.fatal !== undefined ? { fatal: result.fatal } : {}),
    aborted: !!result.aborted,
    traces: state.traces
  }
}
