/**
 * The per-turn runtime CONTEXT + failure types the direct Classic path threads through its stages
 * (execution-plan M5c-1). Relocated OUT of the node-engine `nodes/types.ts` so the turn path
 * (`classicTurn`, `mainSample`, `resilientCall`), the Yuzu gate, and the memory cores keep these after
 * the workflow surface is deleted — none of these types reference the node/graph model, so they carry a
 * ZERO dependency on `shared/workflow`. `nodes/types.ts` re-exports them, so the (still-present, deleted
 * in M5c-2) node registry keeps importing them from `../types` unchanged.
 */

/** The error value a stage carries when it fails (was the node `error` port value). */
export interface NodeError {
  kind: 'A' | 'B'
  message: string
  code?: string
  nodeId: string
  attempts: number
}

/**
 * Thrown to describe HOW a call failed: class A = the request never went through (network / timeout /
 * 429 / 5xx / auth), class B = the output came back but was bad (empty / refusal / failed a validator),
 * plus how many attempts were burned. A plain thrown Error still works and defaults to kind A / 1 attempt.
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

/** Per-turn runtime context threaded to the direct Classic path's stages and the shared model-call core.
 *  The panel/node-state hooks (`emitPanel`/`getNodeState`/`setNodeState`) and the sub-graph fields are
 *  retained on the shape only because the (still-present) node registry shares this type; the direct path
 *  supplies no-op stubs for them. */
export interface RunContext {
  /** Aborts the whole run when the turn is cancelled (Stop). */
  signal: AbortSignal
  /** The main output streams the reply here (→ chat message). */
  streamMain: (delta: string) => void
  /** A node with an opt-in panel streams its output here (→ collapsible panel). */
  emitPanel: (nodeId: string, delta: string) => void
  /** Durable per-(chat,node) scratchpad read. */
  getNodeState: (nodeId: string) => unknown
  /** Durable per-(chat,node) scratchpad write. */
  setNodeState: (nodeId: string, value: unknown) => void
  /** Invoked once, right after the main output completes, so the caller can deliver the response
   *  before any post-response work finishes. Receives the outputs produced so far. */
  onResponseReady?: (outputs?: Map<string, Record<string, unknown>>) => void
  /** The profile driving this run. */
  profileId?: string
  /** The chat this run belongs to. */
  chatId?: string
  /** The workflow this run belongs to — node_state is keyed (chat_id, workflow_id, node_id). */
  workflowId?: string
  /** The raw user action text that started this turn. */
  userAction?: string
  /** The ST generation type driving preset injection_trigger filtering. Absent = 'normal'. */
  generationType?: string
  /** The user's Stop signal, given to the LLM call ONLY (so streaming can abort). Distinct from
   *  `signal` (the graph signal): a user Stop must NOT skip parse/apply/write, because the pipeline
   *  persists a partial floor when the model returns text after Stop. Falls back to `signal` when unset. */
  modelSignal?: AbortSignal
  /** Abort the graph run. Called ONLY on abort-with-empty (nothing to persist), so downstream stages
   *  are skipped and `generate()` returns null. */
  abortGraph?: () => void
  /** Sub-graph nodes v1: the boundary-slot seeds a running sub-graph was invoked with. */
  subgraphSeeds?: Record<string, unknown>
  /** Sub-graph nodes v1: how a running sub-graph's `subgraph.output` nodes report their value back. */
  subgraphCollect?: (slot: string, value: unknown) => void
  /** Sub-graph nodes v1: ids of sub-graph docs currently executing up-stack (recursion guard). */
  subgraphStack?: string[]
}
