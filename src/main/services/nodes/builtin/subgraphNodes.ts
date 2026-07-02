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
    const workflowId = cfg.workflow_id

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
      throw new NodeRunFailure(
        'B',
        `sub-graph workflow "${workflowId}" not found`,
        1,
        'bad-subgraph'
      )
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

    const doc = applyPromotions(raw, cfg.params)

    const seeds: Record<string, unknown> = {
      gen: inputs.gen,
      in1: inputs.in1,
      in2: inputs.in2,
      in3: inputs.in3,
      in4: inputs.in4
    }

    const nextStack = [...stack, workflowId]
    const wrappedCtx: RunContext = {
      ...ctx,
      subgraphStack: nextStack,
      getNodeState: (id) => ctx.getNodeState(`${node.id}/${id}`),
      setNodeState: (id, value) => ctx.setNodeState(`${node.id}/${id}`, value)
    }

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
