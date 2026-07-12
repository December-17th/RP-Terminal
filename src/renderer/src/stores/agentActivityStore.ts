import { create } from 'zustand'

/** Which run phase a side agent's LLM call belongs to. `pre` = a blocking pre-reply call
 *  (memory.recall) the user is waiting on; `post` = an off-the-hot-path call (memory.maintain /
 *  notes.maintain / agent.llm) that runs while the reply is already shown. */
export type ActivityPhase = 'pre' | 'post'

/** One live side-agent LLM call, keyed by its node id in the run (see agentActivityStore.active). */
export interface ActivityEntry {
  nodeType: string
  phase: ActivityPhase
}

/**
 * Live "a SIDE LLM agent is making an API request" state, per chat (agent-activity-indicator).
 *
 * The engine emits `workflow-activity` {chatId,nodeId,nodeType,phase,state:'start'|'end'} around every
 * announce-set node's execution (the calls-llm nodes EXCEPT llm.sample, which already streams via
 * generation-delta). App.tsx subscribes and folds each event in here; ChatView/StreamingView read the
 * derived label so the user knows WHY a turn is stalling (pre) or that background work is running (post).
 *
 * Shape mirrors the other per-chat "latest wins" stores (recallFailOpenStore / agentFailureStore): a
 * plain nodeId→entry map per chat. 'start' adds the entry, 'end' removes it; overlapping side agents
 * (two post nodes at once) coexist as separate keys, and the derived label picks the highest-priority
 * one. A stray 'end' with no matching 'start' is a no-op (fail-soft).
 */
interface AgentActivityState {
  /** chatId → (nodeId → entry) for every side-agent call currently in flight. */
  active: Record<string, Record<string, ActivityEntry>>
  /** A node started its LLM call — add it to the chat's active set. */
  start: (chatId: string, nodeId: string, nodeType: string, phase: ActivityPhase) => void
  /** A node's LLM call settled (success OR failure) — drop it from the chat's active set. */
  end: (chatId: string, nodeId: string) => void
}

export const useAgentActivityStore = create<AgentActivityState>((set) => ({
  active: {},
  start: (chatId, nodeId, nodeType, phase) =>
    set((s) => ({
      active: {
        ...s.active,
        [chatId]: { ...(s.active[chatId] ?? {}), [nodeId]: { nodeType, phase } }
      }
    })),
  end: (chatId, nodeId) =>
    set((s) => {
      const chat = s.active[chatId]
      if (!chat || !(nodeId in chat)) return s
      const next = { ...chat }
      delete next[nodeId]
      const active = { ...s.active }
      if (Object.keys(next).length) active[chatId] = next
      else delete active[chatId]
      return { active }
    })
}))

/** Highest-first display priority when several side agents are active at once (pre-phase recall is
 *  the only pre node in practice; post nodes can overlap). The first match wins the label. */
const ACTIVITY_PRIORITY = ['memory.recall', 'memory.maintain', 'notes.maintain', 'agent.llm']

/** nodeType → the phase-agnostic i18n key for its status label. Unknown types fall back to the
 *  generic agent label so a newly-announced node still surfaces SOMETHING rather than nothing. */
export function activityLabelKey(nodeType: string): string {
  switch (nodeType) {
    case 'memory.recall':
      return 'chat.activity.recall'
    case 'memory.maintain':
      return 'chat.activity.memoryMaintain'
    case 'notes.maintain':
      return 'chat.activity.notesMaintain'
    default:
      return 'chat.activity.agent'
  }
}

/** The nodeType of the highest-priority active side agent for `chatId` in `phase`, or null when none
 *  is running. Pure over the store's `active` map so ChatView, StreamingView, and tests share one rule. */
export function currentActivity(
  active: AgentActivityState['active'],
  chatId: string,
  phase: ActivityPhase
): string | null {
  const chat = active[chatId]
  if (!chat) return null
  const types = Object.values(chat)
    .filter((e) => e.phase === phase)
    .map((e) => e.nodeType)
  if (!types.length) return null
  for (const t of ACTIVITY_PRIORITY) if (types.includes(t)) return t
  // An unknown announced type (not in the priority list) still deserves a label.
  return types[0]
}

/** The i18n key for the current `phase` activity label of `chatId`, or null when nothing is running. */
export function currentActivityLabelKey(
  active: AgentActivityState['active'],
  chatId: string,
  phase: ActivityPhase
): string | null {
  const type = currentActivity(active, chatId, phase)
  return type ? activityLabelKey(type) : null
}
