import { resolveWorkflowDoc } from './workflowService'
import { getNodeState } from './nodeStateService'

/**
 * Last-maintained-floor status per table for the Tables view (issue 06).
 *
 * The `table.gate` node keeps a DURABLE per-(chat, workflow, node) state `{ last: Record<sqlName,
 * number>, at }` — the floor up to which each table was last maintained (`tableNodes.ts` `table.gate`).
 * A workflow can carry MORE THAN ONE gate (e.g. a 世界推进 pass and a 剧情推进 pass), and a table may be
 * watched by several; we surface the MOST RECENT maintenance floor across all of them.
 *
 * `chat-tables-status` resolves the chat's effective workflow (`resolveWorkflowDoc`), reads every
 * `table.gate` node's state, and merges their `last` maps taking the MAX floor per table. Tables that
 * no gate has maintained yet are absent from the merged map; the renderer shows "—" for those.
 */

/** The gate node-state shape we read (a subset — we only need `last`). */
interface GateState {
  last?: Record<string, number>
}

/**
 * PURE merge (unit-tested): the max last-maintained floor per sqlName across every gate's `last` map.
 * Non-number / negative entries are ignored (a gate never writes a negative floor, but be defensive).
 * A table present in no gate is absent from the result → the caller renders "never maintained".
 */
export const mergeLastMaintained = (
  states: Array<Record<string, number> | undefined>
): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const last of states) {
    if (!last) continue
    for (const [sqlName, floor] of Object.entries(last)) {
      if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0) continue
      if (!(sqlName in out) || floor > out[sqlName]) out[sqlName] = floor
    }
  }
  return out
}

/**
 * Resolve the chat's workflow, collect every `table.gate` node's durable `last` map, and merge them
 * (max per table). Returns `Record<sqlName, number>` — a table absent from the map has never been
 * maintained. Best-effort: any resolution / state-read failure yields `{}` (the view degrades to "—").
 */
export const getTablesStatus = (
  profileId: string,
  chatId: string
): Record<string, number> => {
  try {
    const { id: workflowId, doc } = resolveWorkflowDoc(profileId, chatId)
    const gateStates = doc.nodes
      .filter((n) => n.type === 'table.gate')
      .map((n) => (getNodeState(chatId, workflowId, n.id) as GateState | undefined)?.last)
    return mergeLastMaintained(gateStates)
  } catch {
    return {}
  }
}
