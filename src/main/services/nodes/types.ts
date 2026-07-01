// Runtime types for the node workflow engine (spec §4/§5/§10/§11). The pure port/graph model
// lives in src/shared/workflow; these types add the side-effectful run() surface (main-side).
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
}

/** What a node's run() returns: values per output-port name, plus which Signal output ports
 *  fired (control/branch nodes — spec §5). */
export interface NodeResult {
  outputs?: Record<string, unknown>
  signals?: string[]
}

export type NodeRunFn = (
  ctx: RunContext,
  inputs: Record<string, unknown>
) => NodeResult | Promise<NodeResult>

/** A registered node type: its pure descriptor (ports, from shared) + its run(). */
export interface NodeImpl extends NodeDescriptor {
  run: NodeRunFn
}
