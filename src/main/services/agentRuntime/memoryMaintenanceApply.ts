import { normalizeAgentName, parseInvocationPlan } from '../../../shared/agentRuntime'
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
 *
 * BOTH entry shapes are wrapped: `run` (a single invocation) and `runPlan` (a card `AgentHostSession`
 * plan step). A plan dispatches its steps through the base runtime's INTERNAL enqueue, which never
 * routes through the wrapped `run`, so without wrapping `runPlan` a plan step naming the Memory
 * Maintenance Agent would bill the provider, record success, and silently discard its `<TableEdit>`.
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
        applyOnce(bridge, deps, scope, outcome.result)
      })
      .catch(() => undefined)
    return promise
  },
  runPlan(request) {
    const promise = base.runPlan(request)
    const bridge = deps.bridge()
    if (!bridge) return promise
    // Parse the plan the same way the runtime does so we can map each ordered outcome back to the
    // Agent it ran (the outcomes themselves carry no name). base.runPlan already threw on an invalid
    // plan, so a parse failure here is unreachable — fall open rather than crash the apply seam.
    const parsed = parseInvocationPlan(request.plan)
    if (!parsed.ok) return promise
    const floor = request.floor ?? parsed.value.floor
    if (floor === undefined) return promise
    // Flatten steps → calls in the exact order the runtime enqueues them (step order, and call order
    // within a parallel group), matching the order it pushes outcomes.
    const orderedAgents = parsed.value.steps.flatMap((step) =>
      'parallel' in step ? step.parallel.map((call) => call.agent) : [step.agent]
    )
    const memoryName = normalizeAgentName(MEMORY_MAINTENANCE_AGENT_NAME)
    if (!orderedAgents.some((name) => normalizeAgentName(name) === memoryName)) return promise
    const scope: MemoryMaintenanceScope = {
      profileId: request.profileId,
      chatId: request.chatId,
      floor
    }
    void promise
      .then((plan) => {
        plan.outcomes.forEach((outcome, index) => {
          if (normalizeAgentName(orderedAgents[index] ?? '') !== memoryName) return
          if (outcome.status !== 'succeeded') return
          applyOnce(bridge, deps, scope, outcome.result)
        })
      })
      .catch(() => undefined)
    return promise
  }
})

const applyOnce = (
  bridge: { applyResult(scope: MemoryMaintenanceScope, rawResult: unknown): void },
  deps: MemoryMaintenanceApplyDeps,
  scope: MemoryMaintenanceScope,
  rawResult: unknown
): void => {
  try {
    bridge.applyResult(scope, rawResult)
  } catch (cause) {
    deps.warn(
      `Memory Maintenance apply failed — ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}
