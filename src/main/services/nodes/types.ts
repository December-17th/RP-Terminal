// Runtime types for the node workflow engine (spec §4/§5/§10/§11). The pure port/graph model
// lives in src/shared/workflow; these types add the side-effectful run() surface (main-side).
import { ZodType } from 'zod'
import { NodeDescriptor } from '../../../shared/workflow/types'

/** The error value carried on a node's `error` output port (spec §10). */
export interface NodeError {
  kind: 'A' | 'B'
  message: string
  code?: string
  nodeId: string
  attempts: number
}

/**
 * A node throws this to describe HOW it failed (spec §10): class A = the request never went
 * through (network / timeout / 429 / 5xx / auth), class B = the output came back but was bad
 * (empty / refusal / failed the node's validator), plus how many attempts were burned. The
 * engine folds these fields into the NodeError it routes on the node's `error` port; a plain
 * thrown Error still works and defaults to kind A / 1 attempt.
 */
export class NodeRunFailure extends Error {
  kind: 'A' | 'B'
  code?: string
  attempts: number
  constructor(kind: 'A' | 'B', message: string, attempts: number, code?: string) {
    super(message)
    this.name = 'NodeRunFailure'
    this.kind = kind
    this.attempts = attempts
    this.code = code
  }
}

/** Per-turn runtime context threaded to every node's run() (spec §4). Phase 2a includes the
 *  executor-relevant hooks; Phase 2b augments this with domain fields (floors, settings, world,
 *  userAction, scanText, …) without reshaping the executor. */
export interface RunContext {
  /** Aborts the whole run when the turn is cancelled (Stop). */
  signal: AbortSignal
  /** The main-output node streams the reply here (→ chat message). */
  streamMain: (delta: string) => void
  /** A node with an opt-in panel streams its output here (→ collapsible panel). */
  emitPanel: (nodeId: string, delta: string) => void
  /** Durable per-(chat,node) scratchpad read (spec §11). */
  getNodeState: (nodeId: string) => unknown
  /** Durable per-(chat,node) scratchpad write (spec §11). */
  setNodeState: (nodeId: string, value: unknown) => void
  /** Invoked once, right after the main-output node completes, so the caller can deliver the
   *  response before post-response nodes finish (spec §5 phase boundary). Receives the node
   *  outputs produced so far (the main-output node's included) so the caller can extract the
   *  turn result without awaiting the post phase. */
  onResponseReady?: (outputs?: Map<string, Record<string, unknown>>) => void
  /** Turn seed (Phase 2b): the profile driving this run. Optional so Phase 2a bare RunContext
   *  literals (engine tests) still compile — only default-graph nodes that need domain context
   *  (via `input.context`) read this. */
  profileId?: string
  /** Turn seed (Phase 2b): the chat this run belongs to. */
  chatId?: string
  /** Turn seed (Phase 2b-2): the workflow this run belongs to — node_state is keyed
   *  (chat_id, workflow_id, node_id) so clones of the default graph (same node ids by design)
   *  don't collide (workflow spec §11). */
  workflowId?: string
  /** Turn seed (Phase 2b): the raw user action text that started this turn. */
  userAction?: string
  /** The user's Stop signal, given to the LLM call ONLY (so streaming can abort). Distinct from
   *  `signal` (the graph signal the engine watches): a user Stop must NOT skip the graph's
   *  parse/apply/write, because today's pipeline persists a partial floor when the model returns
   *  text after Stop. Falls back to `signal` when unset. */
  modelSignal?: AbortSignal
  /** Abort the graph run. `llm.sample` calls this ONLY on abort-with-empty (nothing to persist),
   *  so the engine skips downstream and `generate()` returns null — matching the old behavior. */
  abortGraph?: () => void
  /** Sub-graph nodes v1 (plan §3/§4): the boundary-slot seeds a running sub-graph was invoked
   *  with — `subgraph.input` reads `subgraphSeeds?.[cfg.slot]`. Set only inside `runSubgraph`'s
   *  wrapped ctx; absent at the top level (a normal turn run). */
  subgraphSeeds?: Record<string, unknown>
  /** Sub-graph nodes v1: how a running sub-graph's `subgraph.output` nodes report their value
   *  back to the wrapper (`runSubgraph` supplies this, writing into its local outputs record). */
  subgraphCollect?: (slot: string, value: unknown) => void
  /** Sub-graph nodes v1: ids of sub-graph docs currently executing up-stack, for the
   *  `subgraph.call` node's recursion guard (self-reference and indirect A→B→A cycles) + a depth
   *  cap. Absent/empty at the top level. */
  subgraphStack?: string[]
}

/** What a node's run() returns: values per output-port name, plus which Signal output ports
 *  fired (control/branch nodes — spec §5). */
export interface NodeResult {
  outputs?: Record<string, unknown>
  signals?: string[]
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
