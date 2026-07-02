import { z } from 'zod'
import { getWorkflowById } from '../../workflowStore'
import { validateWorkflow } from '../../../../shared/workflow/validate'
import { WorkflowDoc } from '../../../../shared/workflow/types'
import { runSubgraph } from '../../workflowEngine'
import { log } from '../../logService'
import { NodeImpl, NodeRunFailure, RunContext } from '../types'
import type { NodeRegistry } from '../registry'

/**
 * Sub-graph nodes (sub-graph nodes v1 plan §3/§4): a reusable sub-graph package is authored as
 * its own `.rptflow` doc (`kind: 'subgraph'`), addressed by declaring `subgraph.input`/
 * `subgraph.output` boundary nodes inside it, and invoked elsewhere as one `subgraph.call`
 * wrapper node. `subgraph.call` has a STATIC descriptor (in1..in4/out1..out4 + gen/when/error) —
 * typed, dynamically-derived ports are an explicit fast-follow, not v1 (plan §1/§8).
 *
 * Two distinct import-cycle concerns, two distinct mitigations:
 *  1. `getWorkflowById` comes from `../../workflowStore` (a LEAF), not `../../workflowService` —
 *     workflowService imports the builtin registry (`./index`) for validation, and `./index`
 *     imports this file, so importing workflowService here would close that into a cycle
 *     (plan §4.2's preferred mitigation — matches the `generation/rawGenerate.ts` precedent).
 *  2. `subgraph.call` also needs the FULL builtin registry itself (to run a nested doc's own
 *     node types via `runSubgraph`) — but the registry's own node list includes `subgraphCall`,
 *     so this file cannot statically import `./index` (self-reference: the registry contains a
 *     node that needs the registry). `setBuiltinRegistry` below is a late-bound setter that
 *     `./index` calls once, right after constructing `builtinRegistry`, so this module never
 *     imports `./index` at all — the ESM runtime here (Vite/esbuild) has no bare `require()`,
 *     so a lazy require-on-call is not viable; a setter avoids any import edge, static or
 *     runtime, in this direction.
 */

const MAX_SUBGRAPH_DEPTH = 8

let registryRef: NodeRegistry | null = null

/** Wires the builtin registry into `subgraph.call` — called once by `builtin/index.ts` right
 *  after `builtinRegistry` is constructed (see header comment concern #2). */
export function setBuiltinRegistry(registry: NodeRegistry): void {
  registryRef = registry
}

function getBuiltinRegistry(): NodeRegistry {
  if (!registryRef)
    throw new NodeRunFailure(
      'B',
      'subgraph.call: builtin registry not wired yet (internal error — setBuiltinRegistry was not called)',
      1,
      'bad-subgraph'
    )
  return registryRef
}

const boundarySlotIn = z.enum(['gen', 'in1', 'in2', 'in3', 'in4'])
const boundarySlotOut = z.enum(['out1', 'out2', 'out3', 'out4'])

const subgraphInputConfig = z.object({
  slot: boundarySlotIn,
  label: z.string().optional()
})

/** Reads one of the wrapper's boundary seeds (gen/in1..in4) inside a running sub-graph. Outside
 *  a sub-graph run (a plain turn doc), `ctx.subgraphSeeds` is undefined — validation forbids this
 *  node type in a 'turn' doc (BOUNDARY_IN_TURN) so that situation should never arise at runtime. */
export const subgraphInput: NodeImpl = {
  type: 'subgraph.input',
  title: 'Sub-graph Input',
  inputs: [],
  outputs: [{ name: 'value', type: 'Any' }],
  configSchema: subgraphInputConfig,
  run: (ctx, _inputs, node) => {
    const cfg = node.config as z.infer<typeof subgraphInputConfig>
    return { outputs: { value: ctx.subgraphSeeds?.[cfg.slot] } }
  }
}

const subgraphOutputConfig = z.object({
  slot: boundarySlotOut,
  label: z.string().optional()
})

/** Reports a value out of a running sub-graph on one of its boundary slots (out1..out4), via
 *  `ctx.subgraphCollect` (supplied by `runSubgraph`). A no-op outside a sub-graph run. */
export const subgraphOutput: NodeImpl = {
  type: 'subgraph.output',
  title: 'Sub-graph Output',
  inputs: [{ name: 'value', type: 'Any' }],
  outputs: [],
  configSchema: subgraphOutputConfig,
  run: (ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof subgraphOutputConfig>
    ctx.subgraphCollect?.(cfg.slot, inputs.value)
    return { outputs: {} }
  }
}

const subgraphCallConfig = z.object({
  workflow_id: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional()
})

/** Recursion/depth guards + load + kind check + validation, shared by `subgraph.call` and
 *  `subgraph.loop` (all failures are class-B NodeRunFailures — routable via the error port). */
function guardAndLoadSubgraph(
  ctx: RunContext,
  workflowId: string
): { doc: WorkflowDoc; registry: NodeRegistry } {
  const stack = ctx.subgraphStack ?? []
  if (stack.length >= MAX_SUBGRAPH_DEPTH)
    throw new NodeRunFailure(
      'B',
      `sub-graph call depth exceeded ${MAX_SUBGRAPH_DEPTH} (possible runaway recursion)`,
      1,
      'recursion'
    )
  if (stack.includes(workflowId))
    throw new NodeRunFailure(
      'B',
      `sub-graph "${workflowId}" is already on the call stack (recursive reference)`,
      1,
      'recursion'
    )

  const raw = getWorkflowById(ctx.profileId!, workflowId)
  if (!raw)
    throw new NodeRunFailure('B', `sub-graph workflow "${workflowId}" not found`, 1, 'bad-subgraph')
  if (raw.kind !== 'subgraph')
    throw new NodeRunFailure(
      'B',
      `workflow "${workflowId}" is not a sub-graph doc (kind: 'subgraph')`,
      1,
      'bad-subgraph'
    )

  const registry = getBuiltinRegistry()
  const v = validateWorkflow(raw, registry.descriptors())
  if (!v.ok)
    throw new NodeRunFailure(
      'B',
      `sub-graph "${workflowId}" failed validation: ${v.errors.map((e) => e.message).join('; ')}`,
      1,
      'bad-subgraph'
    )
  return { doc: raw, registry }
}

/** The per-call-site context both wrappers hand to `runSubgraph`: the target id pushed onto the
 *  recursion stack, and node state/panels prefixed with the WRAPPER's node id so two call sites
 *  of the same sub-graph never share state (plan §4.7). For `subgraph.loop` the prefix is shared
 *  across ITERATIONS on purpose — a `control.when('changed')` inside a loop body is expected to
 *  compare against the previous iteration. */
function wrapCallCtx(ctx: RunContext, wrapperId: string, workflowId: string): RunContext {
  return {
    ...ctx,
    subgraphStack: [...(ctx.subgraphStack ?? []), workflowId],
    getNodeState: (id) => ctx.getNodeState(`${wrapperId}/${id}`),
    setNodeState: (id, value) => ctx.setNodeState(`${wrapperId}/${id}`, value),
    // Panels get the same per-instance isolation as node state (Opus QA finding): an inner
    // panel.show node must not collide with a same-id parent-graph node in the chat panels.
    emitPanel: (id, delta) => ctx.emitPanel(`${wrapperId}/${id}`, delta)
  }
}

/** A sub-graph's exposed parameter interface (`WorkflowDoc.meta.promotions`, plan §2/§5): each
 *  entry names a promoted param, the inner node it targets, and the config key on that node to
 *  overwrite. */
interface Promotion {
  name: string
  nodeId: string
  configKey: string
  label?: string
}

const isPromotionArray = (v: unknown): v is Promotion[] =>
  Array.isArray(v) &&
  v.every(
    (p) =>
      p &&
      typeof p === 'object' &&
      typeof (p as Promotion).name === 'string' &&
      typeof (p as Promotion).nodeId === 'string' &&
      typeof (p as Promotion).configKey === 'string'
  )

/** Clones `doc` with each configured `params[name]` value written onto its promoted node's
 *  config key (plan §4.5). Unknown promotion nodeIds are skipped with a log — never throws. */
function applyPromotions(doc: WorkflowDoc, params: Record<string, unknown> | undefined): WorkflowDoc {
  const promotions = doc.meta?.promotions
  if (!isPromotionArray(promotions) || !params) return doc
  const cloned = structuredClone(doc)
  const nodeById = new Map(cloned.nodes.map((n) => [n.id, n]))
  for (const p of promotions) {
    if (!(p.name in params)) continue
    const value = params[p.name]
    if (value === undefined) continue
    const node = nodeById.get(p.nodeId)
    if (!node) {
      log('error', `subgraph.call: promotion "${p.name}" targets unknown node "${p.nodeId}", skipped`)
      continue
    }
    node.config = { ...(node.config ?? {}), [p.configKey]: value }
  }
  return cloned
}

/** Invokes a `kind: 'subgraph'` doc as one wrapper node. Static ports (plan §1): `gen`/`in1..
 *  in4` in, `out1..out4`/`error` out — the sub-graph's own boundary nodes decide which of these
 *  slots they actually read/write. `config.params` overrides the sub-graph's promoted parameters
 *  (`meta.promotions`) for this call site.
 *
 *  Recursion guard: refuses to invoke a sub-graph already on the call stack (direct or indirect,
 *  A→B→A) and caps nesting depth at 8 — both surface on the `error` port as a class-B failure
 *  with code 'recursion' when wired, else abort the turn.
 *
 *  Node-state isolation: inner nodes see `getNodeState`/`setNodeState` prefixed with this
 *  wrapper's node id, so a `control.when('changed')` (or any other stateful node) inside the
 *  sub-graph is scoped per CALL SITE — two `subgraph.call` nodes referencing the same sub-graph
 *  never share state. Known v1 limitation: a hand-authored/imported doc whose top-level node id
 *  contains "/" (the editor never generates one) could theoretically collide with this prefix;
 *  narrowing the id schema would invalidate existing hand-authored docs, so this is accepted
 *  as-is for v1 (plan §4.7).
 *
 *  Traces v1: only this wrapper node appears in the parent's trace (its ms covers the whole
 *  sub-run) — inner traces are dropped. A flattened wrapper/inner trace view is a fast-follow.
 *
 *  Streaming caution: an `llm.sample` inside a sub-graph still inherits the parent's
 *  `ctx.streamMain` like any other side-branch node — set `stream: false` on it unless the
 *  sub-graph IS meant to be the main output path. */
export const subgraphCall: NodeImpl = {
  type: 'subgraph.call',
  title: 'Sub-graph',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'in1', type: 'Any' },
    { name: 'in2', type: 'Any' },
    { name: 'in3', type: 'Any' },
    { name: 'in4', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'out1', type: 'Any' },
    { name: 'out2', type: 'Any' },
    { name: 'out3', type: 'Any' },
    { name: 'out4', type: 'Any' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: subgraphCallConfig,
  run: async (ctx: RunContext, inputs, node) => {
    const cfg = node.config as z.infer<typeof subgraphCallConfig>
    const { doc: raw, registry } = guardAndLoadSubgraph(ctx, cfg.workflow_id)
    const doc = applyPromotions(raw, cfg.params)

    const seeds: Record<string, unknown> = {
      gen: inputs.gen,
      in1: inputs.in1,
      in2: inputs.in2,
      in3: inputs.in3,
      in4: inputs.in4
    }

    const wrappedCtx = wrapCallCtx(ctx, node.id, cfg.workflow_id)

    const result = await runSubgraph(doc, registry, wrappedCtx, seeds)
    if (result.fatal)
      throw new NodeRunFailure(
        result.fatal.kind,
        result.fatal.message,
        result.fatal.attempts,
        result.fatal.code
      )
    if (result.aborted) return { outputs: {} }
    return {
      outputs: {
        out1: result.outputs.out1,
        out2: result.outputs.out2,
        out3: result.outputs.out3,
        out4: result.outputs.out4
      }
    }
  }
}

const MAX_LOOP_ITERATIONS = 100

const subgraphLoopConfig = z.object({
  workflow_id: z.string().min(1),
  /** 'foreach' (default): run once per element of the in1 array. 'until': feed out1 back into
   *  in1 each iteration and stop when the body reports a truthy out2. */
  mode: z.enum(['foreach', 'until']).optional(),
  /** Hard bound on iterations (the spec §18 "bounded-iteration model" — there is no unbounded
   *  while). foreach additionally stops at the end of the array. */
  max_iterations: z.number().int().min(1).max(MAX_LOOP_ITERATIONS).optional(),
  params: z.record(z.string(), z.unknown()).optional()
})

/** Runs a `kind: 'subgraph'` doc REPEATEDLY inside one wrapper node (the loops/iteration
 *  fast-follow, spec §18). The parent graph stays a DAG — iteration lives entirely inside this
 *  node's run(), bounded by `max_iterations` (default 10, hard cap 100).
 *
 *  Modes (per-iteration boundary seeding; `gen`/`in3`/`in4` pass through unchanged each time,
 *  `in2` carries the iteration INDEX — a wire into the wrapper's in2 is ignored):
 *  - `foreach`: in1 must be an array (null/undefined = empty). Each iteration seeds in1 with one
 *    element. out1 = the collected array of each iteration's out1; out2 = iterations run;
 *    out3/out4 = the LAST iteration's values.
 *  - `until`: iteration 0 seeds in1 from the wire; every later iteration seeds in1 with the
 *    PREVIOUS iteration's out1 (the carry; unwritten out1 keeps the old carry). Stops when an
 *    iteration writes a truthy out2, or at max_iterations. out1 = final carry; out2 =
 *    iterations run; out3/out4 = the last iteration's values.
 *
 *  Shares subgraph.call's recursion guards, promotion params, and per-call-site state/panel
 *  prefixing (the prefix is deliberately iteration-INDEPENDENT — see wrapCallCtx). An inner
 *  fatal aborts the whole loop as this node's failure (routable via `error` when wired); an
 *  abort (Stop) returns empty outputs immediately. */
export const subgraphLoop: NodeImpl = {
  type: 'subgraph.loop',
  title: 'Sub-graph Loop',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'in1', type: 'Any' },
    { name: 'in2', type: 'Any' },
    { name: 'in3', type: 'Any' },
    { name: 'in4', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'out1', type: 'Any' },
    { name: 'out2', type: 'Any' },
    { name: 'out3', type: 'Any' },
    { name: 'out4', type: 'Any' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: subgraphLoopConfig,
  run: async (ctx: RunContext, inputs, node) => {
    const cfg = node.config as z.infer<typeof subgraphLoopConfig>
    const mode = cfg.mode ?? 'foreach'
    const maxIter = cfg.max_iterations ?? 10
    const { doc: raw, registry } = guardAndLoadSubgraph(ctx, cfg.workflow_id)
    const doc = applyPromotions(raw, cfg.params)
    const wrappedCtx = wrapCallCtx(ctx, node.id, cfg.workflow_id)

    const runIteration = async (
      i: number,
      in1: unknown
    ): Promise<Record<string, unknown> | null> => {
      const result = await runSubgraph(doc, registry, wrappedCtx, {
        gen: inputs.gen,
        in1,
        in2: i,
        in3: inputs.in3,
        in4: inputs.in4
      })
      if (result.fatal)
        throw new NodeRunFailure(
          result.fatal.kind,
          `iteration ${i}: ${result.fatal.message}`,
          result.fatal.attempts,
          result.fatal.code
        )
      return result.aborted ? null : result.outputs
    }

    if (mode === 'foreach') {
      const items = inputs.in1 == null ? [] : inputs.in1
      if (!Array.isArray(items))
        throw new NodeRunFailure(
          'B',
          `subgraph.loop(foreach): in1 must be an array, got ${typeof inputs.in1}`,
          1,
          'bad-loop-input'
        )
      if (items.length > maxIter)
        log(
          'info',
          `subgraph.loop "${node.id}": foreach input has ${items.length} items, capped at max_iterations=${maxIter}`
        )
      const collected: unknown[] = []
      let last: Record<string, unknown> = {}
      for (let i = 0; i < items.length && i < maxIter; i++) {
        if (ctx.signal.aborted) return { outputs: {} }
        const outputs = await runIteration(i, items[i])
        if (outputs === null) return { outputs: {} }
        collected.push(outputs.out1)
        last = outputs
      }
      return {
        outputs: { out1: collected, out2: collected.length, out3: last.out3, out4: last.out4 }
      }
    }

    // mode === 'until'
    let carry: unknown = inputs.in1
    let last: Record<string, unknown> = {}
    let count = 0
    for (let i = 0; i < maxIter; i++) {
      if (ctx.signal.aborted) return { outputs: {} }
      const outputs = await runIteration(i, carry)
      if (outputs === null) return { outputs: {} }
      last = outputs
      count++
      if ('out1' in outputs) carry = outputs.out1
      if (outputs.out2) break
    }
    return { outputs: { out1: carry, out2: count, out3: last.out3, out4: last.out4 } }
  }
}
