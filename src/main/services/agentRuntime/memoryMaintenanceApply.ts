import { normalizeAgentName } from '../../../shared/agentRuntime'
import type { InvocationRuntime } from './invocation'
import {
  MEMORY_MAINTENANCE_AGENT_NAME,
  type MemoryMaintenanceScope
} from './memoryMaintenanceSlot'

/**
 * SINGLE-OWNER apply seam for the built-in Memory Maintenance Agent (final-review Finding 1).
 *
 * The durable `<TableEdit>` apply (parse → three-way discrimination → applyTableEdit/advanceProgress,
 * via the bridge) used to hang off the FLOOR-COMMIT TRIGGER dispatch alone, so a manual Workspace
 * "Run now" of the Memory Maintenance Agent composed the real maintainer prompt, billed the provider,
 * recorded success — and then discarded the result. This wrapper hooks the apply where the run outcome
 * settles ONCE, keyed by the Agent's name, at the composition root: any successful invocation of that
 * Agent — trigger OR manual IPC OR a card transport — applies exactly once, and the trigger path no
 * longer applies a second time (its own apply was removed in favour of this seam).
 *
 * The bridge's `applyResult` is idempotently fenced (it consumes the compose context stashed by the
 * prompt planner and drops a moved/superseded floor), so a non-memory Agent, a failed/cancelled run,
 * or a run that never composed simply does nothing here.
 */
export interface MemoryMaintenanceApplyDeps {
  /** The installed bridge's apply consumer, or undefined in lightweight/test compositions. */
  bridge(): { applyResult(scope: MemoryMaintenanceScope, rawResult: unknown): void } | undefined
  warn(message: string): void
}

export const withMemoryMaintenanceApply = (
  base: InvocationRuntime,
  deps: MemoryMaintenanceApplyDeps
): InvocationRuntime => ({
  ...base,
  run(request) {
    const promise = base.run(request)
    const bridge = deps.bridge()
    if (
      !bridge ||
      normalizeAgentName(request.agent) !== normalizeAgentName(MEMORY_MAINTENANCE_AGENT_NAME)
    ) {
      return promise
    }
    const scope: MemoryMaintenanceScope = {
      profileId: request.profileId,
      chatId: request.chatId,
      floor: request.floor
    }
    // Observe completion without changing what the caller awaits (the original InvocationPromise, with
    // its invocationId, is returned unchanged). `run()` never rejects, but the .catch keeps the
    // observer self-contained.
    void promise
      .then((outcome) => {
        if (outcome.status !== 'succeeded') return
        try {
          bridge.applyResult(scope, outcome.result)
        } catch (cause) {
          deps.warn(
            `Memory Maintenance apply failed — ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          )
        }
      })
      .catch(() => undefined)
    return promise
  }
})
