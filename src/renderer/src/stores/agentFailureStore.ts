import { create } from 'zustand'
import type { WorkflowRunTrace } from '../../../shared/workflow/trace'

/**
 * Last HEADLESS-agent run failure per chat, surfaced as a dismissible banner in ChatView so a
 * background agent (e.g. memory.maintain) that fails never passes silently. Fed by the same
 * `workflow-trace` flow App already subscribes to (see App.tsx onWorkflowTrace): a matching
 * failure calls `recordFailure`, a later SUCCESSFUL headless trace for that chat calls `clear`
 * so a stale banner doesn't linger after a retry succeeds. The user can also dismiss it by hand.
 *
 * Only the latest failure per chat is kept (it reflects the last background run). This mirrors
 * workflowTraceStore's per-chat "latest wins" shape.
 */
export interface AgentFailure {
  /** Human-readable failure reason (first failed node's error, else the run's fatal error). */
  reason: string
  /** The failing node's type/id, for a short "which agent" hint in the banner (optional). */
  nodeLabel?: string
}

interface AgentFailureState {
  failures: Record<string, AgentFailure>
  recordFailure: (chatId: string, info: AgentFailure) => void
  clear: (chatId: string) => void
}

export const useAgentFailureStore = create<AgentFailureState>((set) => ({
  failures: {},
  recordFailure: (chatId, info) =>
    set((s) => ({ failures: { ...s.failures, [chatId]: info } })),
  clear: (chatId) =>
    set((s) => {
      if (!(chatId in s.failures)) return s
      const next = { ...s.failures }
      delete next[chatId]
      return { failures: next }
    })
}))

/** True when a trace came from a background (headless / headless-doc) agent run rather than a
 *  player turn. Only these get the silent-failure banner treatment. */
export const isHeadlessTrace = (trace: WorkflowRunTrace): boolean =>
  typeof trace.workflowId === 'string' && trace.workflowId.startsWith('headless')

/**
 * Decide what a headless trace means for the banner. Returns the AgentFailure to record when the
 * run failed, or `null` when it succeeded (so the caller clears any stale banner). Caller must have
 * already gated on {@link isHeadlessTrace}.
 *
 * Failure = `ok === false` OR any node `status === 'failed'`. The node half is REQUIRED and not
 * redundant: the common memory.maintain empty-completion case fails class-B onto its error port, so
 * the RUN stays `ok === true` while a node is `failed`. Relying on `ok` alone would miss it.
 */
export const deriveHeadlessFailure = (trace: WorkflowRunTrace): AgentFailure | null => {
  const failedNode = trace.nodes?.find((n) => n.status === 'failed')
  if (trace.ok !== false && !failedNode) return null
  return {
    reason: failedNode?.error?.message ?? trace.error?.message ?? 'Unknown error',
    nodeLabel: failedNode?.nodeType ?? failedNode?.nodeId ?? trace.error?.nodeId
  }
}
