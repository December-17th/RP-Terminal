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
   *  response before post-response nodes finish (spec §5 phase boundary). */
  onResponseReady?: () => void
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
}

/** What a node's run() returns: values per output-port name, plus which Signal output ports
 *  fired (control/branch nodes — spec §5). */
export interface NodeResult {
  outputs?: Record<string, unknown>
  signals?: string[]
}

/** Per-instance info handed to run(): the node's id (node-state key) and its config —
 *  already parsed through the impl's configSchema when one is declared. */
export interface NodeMeta {
  id: string
  config: Record<string, unknown>
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
