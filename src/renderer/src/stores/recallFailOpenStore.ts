import { create } from 'zustand'
import type { WorkflowRunTrace } from '../../../shared/workflow/trace'

/** After this many CONSECUTIVE pre-turn recall fail-opens for one chat, ChatView shows the amber
 *  "recall keeps failing" banner. A single successful (non-fail-open) recall resets the streak. */
export const RECALL_FAILOPEN_THRESHOLD = 3

/**
 * Consecutive pre-turn plot-recall fail-opens per chat (plot-recall A3). `memory.recall` is fail-open:
 * when its pre-turn side-call fails the turn still runs, just WITHOUT recalled memory. Today the only
 * signal is an amber tint in the run drawer, which a busy player never opens — so a chat can quietly
 * run turn after turn with no memory. This store tallies consecutive fail-opens off the SAME
 * `workflow-trace` flow agentFailureStore already uses (App.tsx onWorkflowTrace) and, once the streak
 * reaches {@link RECALL_FAILOPEN_THRESHOLD}, drives a distinct dismissible ChatView banner.
 *
 * Mirrors agentFailureStore's per-chat "latest wins" shape. A successful recall (a `memory.recall` node
 * that ran without `failedOpen`) resets the streak AND re-arms a previously dismissed banner; a manual
 * dismissal sticks until that reset so a fresh fail-open doesn't immediately re-pop the banner.
 */
interface RecallFailOpenState {
  /** Consecutive fail-open count per chat. */
  counts: Record<string, number>
  /** Chats where the user dismissed the banner (kept until a success resets the streak). */
  dismissed: Record<string, boolean>
  /** Fold one turn's recall outcome in: `true` bumps the streak; `false` resets it (and re-arms). */
  record: (chatId: string, failedOpen: boolean) => void
  /** User hid the banner by hand — keep it hidden until the streak resets. */
  dismiss: (chatId: string) => void
}

export const useRecallFailOpenStore = create<RecallFailOpenState>((set) => ({
  counts: {},
  dismissed: {},
  record: (chatId, failedOpen) =>
    set((s) => {
      if (!failedOpen) {
        // A clean (or skipped) recall — the streak is broken; drop the count + any dismissal so the
        // next failure run starts fresh and the banner can re-arm. Fail-soft when nothing is tracked.
        if (!(chatId in s.counts) && !(chatId in s.dismissed)) return s
        const counts = { ...s.counts }
        const dismissed = { ...s.dismissed }
        delete counts[chatId]
        delete dismissed[chatId]
        return { counts, dismissed }
      }
      return { counts: { ...s.counts, [chatId]: (s.counts[chatId] ?? 0) + 1 } }
    }),
  dismiss: (chatId) =>
    set((s) => (s.dismissed[chatId] ? s : { dismissed: { ...s.dismissed, [chatId]: true } }))
}))

/**
 * The recall outcome carried by one run trace: 'failed' when the `memory.recall` node ran but
 * fail-opened, 'ok' when it ran cleanly (or was skipped), or null when the trace has no recall node at
 * all (irrelevant — leave the streak untouched). Pre-turn recall runs INSIDE the player-turn graph, so
 * this reads TURN traces and does NOT gate on isHeadlessTrace. Pure, so App's listener and tests share
 * one definition.
 */
export function recallOutcome(trace: WorkflowRunTrace): 'ok' | 'failed' | null {
  const node = trace.nodes?.find((n) => n.nodeType === 'memory.recall')
  if (!node) return null
  return node.failedOpen ? 'failed' : 'ok'
}

/** Whether the banner should show for a chat given its streak + dismissal (threshold defaults to
 *  {@link RECALL_FAILOPEN_THRESHOLD}). Pure so ChatView and tests agree on the condition. */
export function shouldShowRecallBanner(
  count: number,
  dismissed: boolean,
  threshold: number = RECALL_FAILOPEN_THRESHOLD
): boolean {
  return count >= threshold && !dismissed
}
