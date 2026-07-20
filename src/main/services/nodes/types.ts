// Runtime types for the node workflow engine (spec §4/§5/§10/§11). The pure port/graph model
// lives in src/shared/workflow; these types add the side-effectful run() surface (main-side).
import { ZodType } from 'zod'
import { NodeDescriptor } from '../../../shared/workflow/types'

// `RunContext`, `NodeError`, and `NodeRunFailure` moved to `generation/runContext.ts`
// (execution-plan M5c-1) so the direct Classic turn path keeps them without importing the node
// engine. Re-exported here so the (still-present) node registry imports them from `../types`
// unchanged.
import { NodeRunFailure } from '../generation/runContext'
import type { NodeError, RunContext } from '../generation/runContext'
export { NodeRunFailure }
export type { NodeError, RunContext }

/** What a node's run() returns: values per output-port name, plus which Signal output ports
 *  fired (control/branch nodes — spec §5). */
export interface NodeResult {
  outputs?: Record<string, unknown>
  signals?: string[]
  /** Output port names the engine must treat as NOT produced this run — it prunes their outgoing
   *  edges (adds them to deadEdge), exactly like the throw path prunes a failed node's non-error
   *  edges. This is the fail-open node's affordance for matching throw-path error semantics WITHOUT
   *  throwing (plot-recall finding A2): a node that internally fails-open (e.g. `memory.recall`) can
   *  emit its `error` value on the `error` port yet declare its NON-error ports dead so downstream
   *  non-error branches don't fire; and on SUCCESS it declares the `error` port dead so a wired error
   *  branch — and the "log undefined" consumer — never fires on a good turn. A dead port whose value
   *  is also present in `outputs` is still delivered to no one (the prune wins). Absent = no ports
   *  pruned (every pre-A2 node behaves exactly as before). */
  deadPorts?: string[]
  /** A node that HANDLED an internal failure without aborting the turn (fail-open — e.g. a caught
   *  side-call failure in `memory.recall`). The node still traces status 'ran' (it did not throw, so
   *  it is not a hard 'failed'), but this marker rides onto the trace so the UI can tint it as a
   *  warning and the failure is not invisible behind a green row (finding A3). Purely advisory —
   *  the engine does not change control flow on it. Absent = a clean run. */
  failedOpen?: boolean
  /** Debug-only detail for the run trace (NOT graph output ports — never wired, never read by
   *  downstream nodes). The engine folds these into the node's trace so they surface in the run
   *  drawer's Runs tab, keyed by label. Used by `agent.llm` to expose the COMPOSED prompt it sent
   *  (the interpolated + spliced messages), so "is it actually being sent" is inspectable — the
   *  reason the dropped-{{input}} bug was hard to see. Values are stringified + capped in the trace. */
  debug?: Record<string, unknown>
}

/** Per-instance info handed to run(): the node's id (node-state key) and its config —
 *  already parsed through the impl's configSchema when one is declared. */
export interface NodeMeta {
  id: string
  config: Record<string, unknown>
  /** Agent & memory UX (WP-B; plan §0.2): the input-port names that have ≥1 incoming edge in the
   *  doc — REGARDLESS of whether the edge is live or dead this run. Lets a node distinguish
   *  "wired but not fired" (port named here, key absent from `inputs`) from "not wired at all"
   *  (absent from both) — the distinction `control.mode`'s firing rule needs. Optional so direct
   *  run() callers (tests, previews) that predate WP-B still compile; the engine always supplies
   *  it. No pre-WP-B node reads it, so behavior is unchanged across the registry. */
  wiredInputs?: string[]
}

export type NodeRunFn = (
  ctx: RunContext,
  inputs: Record<string, unknown>,
  node: NodeMeta
) => NodeResult | Promise<NodeResult>

/** A registered node type: its pure descriptor (ports, from shared) + its run(). */
export interface NodeImpl extends NodeDescriptor {
  run: NodeRunFn
  /** Optional zod schema for NodeInstance.config; the engine parses config through it before
   *  run() — a parse failure follows the normal node-failure path (spec §12/§14). */
  configSchema?: ZodType
}
