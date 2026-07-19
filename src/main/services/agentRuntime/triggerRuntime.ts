import type { AgentTrigger, CardFloorCommit } from '../../../shared/agentRuntime'
import { onCardFloorCommitted } from './cardAgentEvents'
import { AgentCatalog } from './catalog'
import { invocationRuntime } from './InvocationRuntimeService'
import { agentRunStore } from './runs/AgentRunStore'
import { isEngineReady, whenTemplatesReady } from '../templateService'
import { log } from '../logService'

/**
 * FLOOR-COMMIT TRIGGER RUNTIME (execution-plan M3, decision D1(a)).
 *
 * Evaluates each enabled catalog Agent's declarative `trigger.onFloorCommitted` cadence at the ONE
 * new-floor boundary — the `emitCardFloorCommitted` call inside `saveFloor`'s `isNewFloor`-guarded
 * callback (chatService.appendFloor). Reusing that boundary (rather than adding a second emit site) is
 * what makes replay and re-incorporation NOT fire triggers: the guard already suppresses the event on
 * a non-new floor.
 *
 * CADENCE RULE (matches the workflow `trigger.cadence` semantics in headlessRunService verbatim): with
 * `lastFire` = the floor of this Agent's most recent Run Record (never run → −1), the Agent is DUE when
 * `committedFloor − lastFire ≥ everyNFloors`. The baseline is DERIVED from runs rather than a pointer
 * table, so it is automatically rewind-correct — deleting floors deletes their runs, the baseline
 * recedes, and the Agent refires. A dispatched run is recorded at the committed floor, so the next fire
 * is `everyNFloors` further on, exactly as the workflow path advances its `lastFireFloor` to `current`.
 *
 * Dispatch goes through the SAME `invocationRuntime().run` identity path a manual "Run now" uses (both
 * target the latest committed floor), so coalescing, lanes, floor ownership, deletion, and the
 * `blocksNextTurn` barrier all apply unchanged.
 */

export interface FloorCommitTriggerDeps {
  /** The profile's catalog Agents (effective definitions), enabled flag included. */
  catalogAgents(profileId: string): Array<{ name: string; enabled: boolean; trigger?: AgentTrigger }>
  /** The floor of the Agent's most recent Run Record in this chat, or null when it never ran. */
  latestRunFloor(chatId: string, agentName: string): number | null
  /** Dispatch a triggered Invocation at the committed floor (the identity path). */
  dispatch(request: { profileId: string; chatId: string; floor: number; agent: string }): void
  /** Whether the template engine is ready (synchronous probe). */
  isReady(): boolean
  /** Resolves when the template engine finishes loading (awaited only on a not-ready first dispatch). */
  whenReady(): Promise<void>
}

/**
 * Build the floor-commit listener. Pure over its deps so the cadence decision is unit-testable without
 * a live catalog, run store, or template engine.
 */
export const createFloorCommitTriggerRuntime = (
  deps: FloorCommitTriggerDeps
): ((profileId: string, chatId: string, event: CardFloorCommit) => void) => {
  return (profileId, chatId, event) => {
    for (const agent of deps.catalogAgents(profileId)) {
      const cadence = agent.trigger?.onFloorCommitted
      if (!agent.enabled || !cadence) continue
      const lastFire = deps.latestRunFloor(chatId, agent.name) ?? -1
      if (event.floor - lastFire < cadence.everyNFloors) continue
      const request = { profileId, chatId, floor: event.floor, agent: agent.name }
      if (deps.isReady()) {
        // Common case: the engine is ready, so dispatch synchronously — `run()` registers a
        // `blocksNextTurn` barrier synchronously, in time for the next turn to await it.
        deps.dispatch(request)
      } else {
        // Startup race (plan §6 risk 5): the template engine has not finished loading. Defer this
        // first dispatch until it has, so the triggered Agent assembles against a live engine instead
        // of falling open to raw prompt text. Only reachable in the brief window right after launch.
        void deps
          .whenReady()
          .then(() => deps.dispatch(request))
          .catch((cause) =>
            log('error', `floor-commit trigger dispatch failed — ${errorMessage(cause)}`)
          )
      }
    }
  }
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

let dispose: (() => void) | null = null

/**
 * Register the floor-commit trigger evaluation against the live event boundary. Idempotent. Wired at
 * startup after the Invocation Runtime is initialized (index.ts).
 */
export const initializeFloorCommitTriggers = (): void => {
  if (dispose) return
  const catalogs = new Map<string, AgentCatalog>()
  const catalogFor = (profileId: string): AgentCatalog => {
    let catalog = catalogs.get(profileId)
    if (!catalog) {
      catalog = new AgentCatalog(profileId)
      catalogs.set(profileId, catalog)
    }
    return catalog
  }
  const evaluate = createFloorCommitTriggerRuntime({
    catalogAgents: (profileId) =>
      catalogFor(profileId).list().map((agent) => ({
        name: agent.name,
        enabled: agent.enabled,
        ...(agent.effective.trigger ? { trigger: agent.effective.trigger } : {})
      })),
    latestRunFloor: (chatId, agentName) => agentRunStore.latestRunFloor(chatId, agentName),
    dispatch: (request) => {
      // Fire-and-forget: the turn never waits on a triggered run here (a blocksNextTurn Agent gates the
      // NEXT turn via the barrier, not this commit). A rejection is impossible (run() never throws) but
      // the outcome promise is observed so an unhandled rejection can never surface.
      void invocationRuntime()
        .run(request)
        .catch((cause: unknown) =>
          log('error', `triggered Agent run failed — ${errorMessage(cause)}`)
        )
    },
    isReady: () => isEngineReady(),
    whenReady: () => whenTemplatesReady()
  })
  dispose = onCardFloorCommitted((profileId, chatId, event) => {
    try {
      evaluate(profileId, chatId, event)
    } catch (cause) {
      // A trigger-evaluation fault must never break floor persistence (the emit boundary swallows too).
      log('error', `floor-commit trigger evaluation failed — ${errorMessage(cause)}`)
    }
  })
}

export const shutdownFloorCommitTriggers = (): void => {
  dispose?.()
  dispose = null
}
