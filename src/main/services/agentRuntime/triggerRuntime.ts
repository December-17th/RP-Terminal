import {
  normalizeAgentName,
  type AgentTrigger,
  type CardFloorCommit,
  type InvocationOptions
} from '../../../shared/agentRuntime'
import { onCardFloorCommitted } from './cardAgentEvents'
import { AgentCatalog } from './catalog'
import { invocationRuntime } from './InvocationRuntimeService'
import type { InvocationOutcome, InvocationRequest } from './invocation'
import {
  MEMORY_MAINTENANCE_AGENT_NAME,
  memoryMaintenanceBridge
} from './memoryMaintenanceSlot'
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
  /** The profile's catalog Agents (effective definitions), enabled flag + the profile-local API-preset
   *  choice (execution-plan M5b — sourced from the catalog invocation config, NOT the definition). */
  catalogAgents(
    profileId: string
  ): Array<{ name: string; enabled: boolean; trigger?: AgentTrigger; apiPresetId?: string }>
  /** The floor of the Agent's most recent Run Record in this chat, or null when it never ran. */
  latestRunFloor(chatId: string, agentName: string): number | null
  /** Dispatch a triggered Invocation at the committed floor (the identity path). */
  dispatch(request: {
    profileId: string
    chatId: string
    floor: number
    agent: string
    apiPresetId?: string
  }): void
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
    // Floor 0 is the greeting commit (chatService.appendFloor seeds `first_mes` as floor 0), NOT a
    // player turn. Evaluating cadence here would fire an everyNFloors:1 Agent at chat creation — a
    // boundary the deleted post-turn evaluation never had (final-review Finding 6). Skip it so cadence
    // first fires on the floor its N implies, counting from the first real turn (floor 1 onward).
    if (event.floor === 0) return
    for (const agent of deps.catalogAgents(profileId)) {
      const cadence = agent.trigger?.onFloorCommitted
      if (!agent.enabled || !cadence) continue
      const lastFire = deps.latestRunFloor(chatId, agent.name) ?? -1
      if (event.floor - lastFire < cadence.everyNFloors) continue
      const request = {
        profileId,
        chatId,
        floor: event.floor,
        agent: agent.name,
        ...(agent.apiPresetId ? { apiPresetId: agent.apiPresetId } : {})
      }
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

export interface TriggerDispatchRequest {
  profileId: string
  chatId: string
  floor: number
  agent: string
  /** The profile-local API-preset choice for this Agent (execution-plan M5b — from the catalog
   *  invocation config, mapped to `InvocationOptions.apiPresetId` here). */
  apiPresetId?: string
}

export interface TriggerDispatchDeps {
  /** Dispatch through the identity path (production: `invocationRuntime().run`). */
  run(request: InvocationRequest): Promise<InvocationOutcome>
  /** The Memory Maintenance bridge's DUE-GATE, or undefined (lightweight/test compositions). */
  memoryBridge(): {
    planDispatch(scope: { profileId: string; chatId: string; floor: number }): {
      apiPresetId?: string
    } | null
  } | undefined
  warn(message: string): void
}

/**
 * The per-Agent dispatch decision, factored out of the wiring so the M4 memory gating is unit-testable
 * without the live runtime. The API-preset rides the request from the catalog's profile-local
 * invocation config (execution-plan M5b). For the built-in Memory Maintenance Agent it consults the
 * bridge's INTERNAL due-gate BEFORE `run()` — a `null` plan means nothing is due, so the dispatch is
 * skipped and no empty Run Record forms. The durable `<TableEdit>` apply is NO LONGER done here: it is
 * the single-owner completion seam at the composition root (`withMemoryMaintenanceApply`, final-review
 * Finding 1), so it runs for ANY successful invocation and this path never double-applies. Every Agent
 * dispatches fire-and-forget.
 */
export const createTriggerDispatch = (
  deps: TriggerDispatchDeps
): ((request: TriggerDispatchRequest) => void) => {
  return (request) => {
    const bridge = deps.memoryBridge()
    const isMemory =
      !!bridge &&
      normalizeAgentName(request.agent) === normalizeAgentName(MEMORY_MAINTENANCE_AGENT_NAME)
    // The re-homed per-Agent API-preset (profile-local invocation config), applied to every triggered
    // Agent uniformly.
    const options: InvocationOptions | undefined = request.apiPresetId
      ? { apiPresetId: request.apiPresetId }
      : undefined
    if (isMemory) {
      const plan = bridge!.planDispatch({
        profileId: request.profileId,
        chatId: request.chatId,
        floor: request.floor
      })
      // Nothing due: SKIP entirely (no run, no provider call, no Run Record — plan §6 risk 3's "no
      // empty Run Records pile up").
      if (plan === null) return
    }
    const identity = {
      profileId: request.profileId,
      chatId: request.chatId,
      floor: request.floor,
      agent: request.agent
    }
    const runRequest: InvocationRequest = options ? { ...identity, options } : { ...identity }
    // Fire-and-forget: the turn never waits here (a blocksNextTurn Agent gates the NEXT turn via the
    // barrier). `run()` never throws, but the outcome promise is observed so nothing goes unhandled;
    // a successful memory run applies via the composition-root seam, not here.
    void deps
      .run(runRequest)
      .catch((cause: unknown) => deps.warn(`triggered Agent run failed — ${errorMessage(cause)}`))
  }
}

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
  const dispatch = createTriggerDispatch({
    run: (request) => invocationRuntime().run(request),
    memoryBridge: () => memoryMaintenanceBridge(),
    warn: (message) => log('error', message)
  })
  const evaluate = createFloorCommitTriggerRuntime({
    catalogAgents: (profileId) =>
      catalogFor(profileId).list().map((agent) => ({
        name: agent.name,
        enabled: agent.enabled,
        ...(agent.effective.trigger ? { trigger: agent.effective.trigger } : {}),
        ...(agent.invocationConfig.apiPresetId
          ? { apiPresetId: agent.invocationConfig.apiPresetId }
          : {})
      })),
    latestRunFloor: (chatId, agentName) => agentRunStore.latestRunFloor(chatId, agentName),
    dispatch,
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
