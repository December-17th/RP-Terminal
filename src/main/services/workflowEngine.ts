import { WorkflowDoc, Edge, NodeDescriptor } from '../../shared/workflow/types'
import { validateWorkflow, ValidationError } from '../../shared/workflow/validate'
import { topoOrder } from '../../shared/workflow/graph'
import { CompositionMeta } from '../../shared/workflow/compose'
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
  /** Node ids whose failure must NOT abort the turn even in the pre-phase (agent-packs plan WP1.3;
   *  ADR 0002: "failure semantics follow attachment mode, per edge — branch fragments fail open even
   *  before the reply"). Derived from `doc.meta.composition` at run start (see failOpenNodesOf);
   *  EMPTY when no packs are composed → every node keeps today's semantics exactly (the zero-packs
   *  guarantee). Consulted only at the unwired-failure point in runNodes. */
  failOpen: Set<string>
}

/** The set of pack node ids that fail open (never fatal) — the nodes a composed pack marked mode
 *  'branch' in ANY pack's `nodeModes` (compose.ts PackComposition). An 'inline' node is load-bearing
 *  and keeps fatal semantics, so it is NOT in this set; a narrator node is in no pack's nodeModes and
 *  is likewise absent. A doc without `meta.composition` (the zero-packs case, and every 'turn'/
 *  'subgraph' doc that never went through composeEffectiveGraph) yields the empty set — additive,
 *  behavior-preserving. Trace attribution stays intact: ids keep their `pack:<packId>:` prefix
 *  (compose.ts PACK_PREFIX), which is exactly what this set keys on. */
function failOpenNodesOf(doc: WorkflowDoc): Set<string> {
  const set = new Set<string>()
  const composition = (doc.meta as { composition?: CompositionMeta } | undefined)?.composition
  if (!composition) return set
  for (const pack of Object.values(composition.packs)) {
    for (const [nodeId, mode] of Object.entries(pack.nodeModes)) {
      if (mode === 'branch') set.add(nodeId)
    }
  }
  return set
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
    // topo pass (the one true prune; graph.ts's static prunedNodes was retired for drifting).
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
        // Killing every outgoing edge here is ALSO what makes a failed branch fragment's rejoin
        // "absent" for free (agent-packs plan WP1.3; ADR 0002): a spliced rejoin edge is just an
        // outgoing edge of this node, so it lands in deadEdge; the narrator anchor it fed (e.g.
        // prompt.assemble's `block`) then reads unwired and runs normally, and downstream pack nodes
        // whose incoming edges are all dead are pruned to 'skipped' by the existing prune rules
        // above. No separate rejoin bookkeeping is needed — composition.rejoinEdges is redundant with
        // this propagation for the engine's purposes.
        for (const out of outs) state.deadEdge.add(edgeKey(out))
        // Composition-aware fail-open (ADR 0002 consequences; agent-packs plan WP1.3): a branch
        // fragment node is fail-open even in the pre-phase — trace it 'failed' (done above) and let
        // the turn continue, exactly like a post-phase unwired failure. `state.failOpen` is empty
        // whenever no packs are composed, so this reduces to the original `phase === 'pre'` rule.
        if (phase === 'pre' && !state.failOpen.has(id)) return { fatal: nodeError }
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

/** The nodes EXCLUDED from a turn run (one-canvas rebuild WP6.1; ADR 0011), by two rules:
 *  · TRIGGER roots — a node whose descriptor is `isTrigger` never runs in a turn (it's an agent's
 *    timing marker; it fires only headlessly). Its downstream chain is pruned via the dead-edge seed.
 *  · DISABLED nodes — a node with `disabled: true` (any node type) never runs; its downstream reads
 *    unwired (existing dead-edge semantics).
 *  A doc with NO trigger nodes and NO disabled nodes yields the EMPTY set → the seed below is a no-op
 *  and turn behavior is byte-identical to pre-WP6.1 (the zero-triggers guarantee). Both rules feed the
 *  SAME seed (skip-trace + dead outgoing edges), so the engine's existing prune rules (`allDead` /
 *  `gatedOff` in runNodes) propagate the skip through each excluded node's exclusive downstream. */
function computeExcluded(doc: WorkflowDoc, registry: NodeRegistry): Set<string> {
  const excluded = new Set<string>()
  for (const n of doc.nodes) {
    if (n.disabled === true) {
      excluded.add(n.id)
      continue
    }
    if (registry.get(n.type)?.isTrigger) excluded.add(n.id)
  }
  return excluded
}

/** Pre-seed the excluded nodes into `state`: trace each 'skipped' (phase 'pre' — a stable, existing
 *  status; the UI dims them later per ADR 0011) and mark ALL their outgoing edges dead so the prune
 *  rules skip their exclusive downstream. Idempotent-safe: a downstream node still reachable from a
 *  LIVE source (e.g. a chain node shared with the narrator) keeps its live incoming edge and runs —
 *  exclusion never over-prunes a node that has another live parent. */
function seedExcluded(doc: WorkflowDoc, excluded: Set<string>, state: ExecState): void {
  const outgoing = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  for (const e of doc.edges) outgoing.get(e.from.node)?.push(e)
  for (const id of excluded) {
    state.traces.push({ nodeId: id, status: 'skipped', phase: 'pre' })
    for (const out of outgoing.get(id) ?? []) state.deadEdge.add(edgeKey(out))
  }
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
    traces: [],
    failOpen: failOpenNodesOf(doc)
  }

  // One-canvas rebuild (WP6.1; ADR 0011): trigger roots + disabled nodes are excluded from the turn.
  const excluded = computeExcluded(doc, registry)

  // A DISABLED main-output node is a DEFINED failure, not undefined behavior: the turn can produce no
  // reply, so we fail the run loudly (a class-A NodeError) rather than silently skipping the output.
  // (A trigger node is never main-output — validation's MAIN_OUTPUT rule + the trigger's Signal-only
  // ports keep isMainOutput off a trigger — so only `disabled` can exclude the main output.)
  const mainNode = doc.nodes.find((n) => n.isMainOutput)
  if (mainNode && excluded.has(mainNode.id)) {
    const error: NodeError = {
      kind: 'A',
      message: `main-output node "${mainNode.id}" is disabled — the turn cannot produce a reply`,
      nodeId: mainNode.id,
      attempts: 0
    }
    return { ok: false, aborted: false, traces: [], outputs: state.outputs, error }
  }

  // Pre-seed excluded nodes (skip-trace + dead outgoing edges) so the existing prune rules skip their
  // exclusive downstream. No-op when `excluded` is empty (zero-triggers guarantee).
  seedExcluded(doc, excluded, state)

  const order = topoOrder(doc).filter((id) => !excluded.has(id))
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
    traces: [],
    // A subgraph run is a self-contained unit invoked inside its wrapper node's own phase; it is
    // never composed with agent-pack fragments, so its fail-open set is always empty (unchanged
    // subgraph semantics — a subgraph doc carries no meta.composition).
    failOpen: failOpenNodesOf(doc)
  }

  // DISABLED nodes are honored inside a sub-graph / headless closure too (one-canvas rebuild WP6.1):
  // a disabled node skips + its downstream reads unwired, same as in a turn. We do NOT exclude
  // `isTrigger` nodes here — a headless closure INTENTIONALLY contains its fired trigger, which must
  // run to fire its signal + un-gate the chain. Pack-era fragments carry no `disabled` nodes, so this
  // is a no-op on that path (its zero-guarantee is preserved).
  const disabled = new Set(doc.nodes.filter((n) => n.disabled === true).map((n) => n.id))
  seedExcluded(doc, disabled, state)

  const order = topoOrder(doc).filter((id) => !disabled.has(id))
  const result = await runNodes(order, doc, registry, ctx, state, 'pre')

  return {
    outputs,
    ...(result.fatal !== undefined ? { fatal: result.fatal } : {}),
    aborted: !!result.aborted,
    traces: state.traces
  }
}
