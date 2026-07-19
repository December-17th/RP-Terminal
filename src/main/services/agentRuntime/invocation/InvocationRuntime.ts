import crypto from 'crypto'

import {
  normalizeAgentName,
  parseInvocationPlan,
  type InvocationOptions,
  type InvocationPlanCall,
  type JsonObject,
  type JsonValue
} from '../../../../shared/agentRuntime'
import type { CatalogAgent } from '../catalog'
import type { HarnessExecutionResult, HarnessFailure } from '../harness'
import type { HarnessRunRequest } from '../runs'
import type { AgentRunReplayOutcome } from '../../../../shared/agentRuntime'
import type { ToolExecutionScope } from '../tools'

export const INVOCATION_DEFAULTS = {
  required: true,
  maxRetryAttempts: 5,
  retryDelayMs: 5000
} as const

export interface InvocationCatalogPort {
  get(profileId: string, name: string): CatalogAgent | null
}

export interface InvocationHarnessPort {
  execute(request: HarnessRunRequest): Promise<HarnessExecutionResult>
  commitSuccess?(
    invocationId: string,
    execution: Extract<HarnessExecutionResult, { ok: true }>,
    replay: AgentRunReplayOutcome
  ): void
  commitFailure?(
    invocationId: string,
    failure: HarnessFailure,
    replay?: AgentRunReplayOutcome
  ): void
  stop(invocationId: string): boolean
  shutdown?(): void
}

export interface InvocationSourceSnapshot {
  /** Opaque FloorState snapshot/epoch identity. */
  token: string
  input: JsonObject
  promptValues?: Record<string, JsonValue>
  history?: JsonValue
}

export interface InvocationFloorPort {
  resolveSource(request: {
    profileId: string
    chatId: string
    floor: number
    agent: CatalogAgent
    options?: InvocationOptions
  }): Promise<InvocationSourceSnapshot>
  isSourceCurrent(
    source: InvocationSourceSnapshot,
    context?: { parallelIndependent: boolean }
  ): boolean | Promise<boolean>
  incorporate(request: {
    invocationId: string
    profileId: string
    chatId: string
    floor: number
    agent: CatalogAgent
    source: InvocationSourceSnapshot
    parallelIndependent: boolean
    execution: Extract<HarnessExecutionResult, { ok: true }>
    saveAs?: InvocationOptions['saveAs']
    /** Must be invoked inside the same session-DB transaction that publishes incorporation. */
    commitRun(): void
  }): Promise<
    | { status: 'committed' }
    | { status: 'stale' }
    | { status: 'deleted' }
    | { status: 'failed'; failure: HarnessFailure }
  >
}

export interface InvocationRunStorePort {
  deleteFromFloor(chatId: string, fromFloor: number): void
}

/**
 * Prompt-policy seam (ADR 0021). The Invocation Runtime knows the chat scope (profile/chat/floor)
 * but must NOT own — or import — the template engine, so it asks this injected port for a renderer
 * and hands it to the Harness. Wired at the `InvocationRuntimeService` composition root; absent in
 * lightweight/test compositions, where prompts stay verbatim.
 */
export type InvocationPromptRendererPort = (scope: {
  profileId: string
  chatId: string
  floor: number
}) => ((text: string) => string) | undefined

export interface InvocationRequest {
  profileId: string
  chatId: string
  floor: number
  agent: string
  options?: InvocationOptions
  /** Authoritative mounted-card implementation scope, injected by the card transport only. */
  toolScope?: ToolExecutionScope
  signal?: AbortSignal
}

export interface InvocationSuccess {
  invocationId: string
  status: 'succeeded'
  result: JsonValue | undefined
  sourceRestarts: number
  required: boolean
}

export interface InvocationFailure {
  invocationId: string
  status: 'failed'
  failure: HarnessFailure
  sourceRestarts: number
  required: boolean
}

export interface InvocationCancellation {
  invocationId: string
  status: 'cancelled'
  sourceRestarts: number
  required: boolean
}

export type InvocationOutcome = InvocationSuccess | InvocationFailure | InvocationCancellation

export interface InvocationPlanRequest {
  profileId: string
  chatId: string
  floor?: number
  plan: unknown
  toolScope?: ToolExecutionScope
  signal?: AbortSignal
}

export interface InvocationPlanOutcome {
  planId: string
  status: 'succeeded' | 'failed' | 'cancelled'
  outcomes: InvocationOutcome[]
}

export interface InvocationPromise extends Promise<InvocationOutcome> {
  readonly invocationId: string
}

export interface InvocationPlanPromise extends Promise<InvocationPlanOutcome> {
  readonly planId: string
}

export type NextTurnBarrierState =
  | { status: 'clear'; pending: 0; failures: [] }
  | { status: 'pending'; pending: number; failures: HarnessFailure[] }
  | { status: 'failed'; pending: 0; failures: HarnessFailure[] }

export interface InvocationRuntime {
  run(request: InvocationRequest): InvocationPromise
  runPlan(request: InvocationPlanRequest): InvocationPlanPromise
  cancelInvocation(invocationId: string): boolean
  cancelPlan(planId: string): boolean
  cancelFloors(chatId: string, fromFloor: number): void
  deleteFloors(chatId: string, fromFloor: number): void
  invalidateSources(chatId: string, throughFloor: number): void
  getNextTurnBarrier(chatId: string): NextTurnBarrierState
  waitForNextTurnBarriers(chatId: string): Promise<NextTurnBarrierState>
  /** READ-ONLY liveness probe (Classic Narrator plan, Milestone 4): is any Agent invocation queued,
   *  running, or is any plan still stepping? Synchronous and side-effect free — one of the three
   *  sources unioned into `hasActiveBackgroundWork()`. */
  hasActiveWork(): boolean
  shutdown(): void
}

export class InvocationRuntimeError extends Error {
  constructor(
    readonly code: 'INVALID_PLAN',
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'InvocationRuntimeError'
  }
}

interface Dependencies {
  catalog: InvocationCatalogPort
  harness: InvocationHarnessPort
  floor: InvocationFloorPort
  runStore?: InvocationRunStorePort
  promptRenderer?: InvocationPromptRendererPort
  createId?: () => string
}

interface QueuedInvocation {
  invocationId: string
  identity: string
  request: InvocationRequest
  parallelIndependent: boolean
  planId?: string
  controller: AbortController
  attemptController?: AbortController
  stale: boolean
  deleted: boolean
  finished: boolean
  promise: InvocationPromise
  resolve(outcome: InvocationOutcome): void
}

interface PlanState {
  controller: AbortController
  invocations: Set<string>
}

interface Barrier {
  invocationId: string
  required: boolean
  settled: Promise<void>
  settle(): void
  failure?: HarnessFailure
}

const failure = (code: string, message: string): HarnessFailure => ({
  code,
  message,
  retryable: false
})

const cancelled = (
  invocationId: string,
  required: boolean,
  sourceRestarts: number
): InvocationCancellation => ({
  invocationId,
  status: 'cancelled',
  sourceRestarts,
  required
})

const hasIrreversibleBoundary = (execution: HarnessExecutionResult): boolean =>
  execution.evidence.attempts.some(
    (attempt) =>
      attempt.irreversibleBoundary === true || (attempt.irreversibleBoundaries?.length ?? 0) > 0
  )

const linkSignal = (source: AbortSignal | undefined, target: AbortController): (() => void) => {
  if (!source) return () => undefined
  if (source.aborted) {
    target.abort(source.reason)
    return () => undefined
  }
  const abort = (): void => target.abort(source.reason)
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

const invocationOptions = (
  options: InvocationOptions | undefined
): Omit<InvocationOptions, 'floor' | 'input' | 'inputBindings'> | undefined => {
  if (!options) return undefined
  const { floor: _floor, input: _input, inputBindings: _bindings, ...rest } = options
  return rest
}

const callOptions = (call: InvocationPlanCall): InvocationOptions => {
  const { agent: _agent, input, ...options } = call
  return { ...options, ...(input ? { inputBindings: input } : {}) }
}

export const createInvocationRuntime = ({
  catalog,
  harness,
  floor,
  runStore,
  promptRenderer,
  createId = () => crypto.randomUUID()
}: Dependencies): InvocationRuntime => {
  const identities = new Map<string, QueuedInvocation>()
  const invocations = new Map<string, QueuedInvocation>()
  const lanes = new Map<string, QueuedInvocation[]>()
  const runningLanes = new Set<string>()
  const plans = new Map<string, PlanState>()
  const barriers = new Map<string, Map<string, Barrier>>()
  let shutDown = false

  const identityFor = (request: InvocationRequest): string =>
    `${request.chatId}\u0000${request.floor}\u0000${normalizeAgentName(request.agent)}`
  const laneFor = (request: InvocationRequest): string =>
    `${request.chatId}\u0000${normalizeAgentName(request.agent)}`

  const barrierMap = (chatId: string): Map<string, Barrier> => {
    let map = barriers.get(chatId)
    if (!map) {
      map = new Map()
      barriers.set(chatId, map)
    }
    return map
  }

  const startBarrier = (
    item: QueuedInvocation,
    required: boolean,
    blocksNextTurn: boolean
  ): Barrier | undefined => {
    if (!blocksNextTurn) return undefined
    let settle!: () => void
    const barrier: Barrier = {
      invocationId: item.invocationId,
      required,
      settled: new Promise<void>((resolve) => {
        settle = resolve
      }),
      settle: () => settle()
    }
    barrierMap(item.request.chatId).set(item.invocationId, barrier)
    return barrier
  }

  const finishBarrier = (
    item: QueuedInvocation,
    barrier: Barrier | undefined,
    outcome: InvocationOutcome
  ): void => {
    if (!barrier) return
    if (outcome.status === 'failed' && barrier.required) {
      barrier.failure = outcome.failure
    } else {
      barrierMap(item.request.chatId).delete(item.invocationId)
    }
    barrier.settle()
  }

  const runQueued = async (item: QueuedInvocation): Promise<InvocationOutcome> => {
    let sourceRestarts = 0
    let retryAttemptsConsumed = 0
    let corrective:
      | {
          source: InvocationSourceSnapshot
          rejectedOutput: string
          failure: HarnessFailure
          reservedRetry: boolean
        }
      | undefined
    let barrier: Barrier | undefined
    let required: boolean = INVOCATION_DEFAULTS.required
    const disposeRequestSignal = linkSignal(item.request.signal, item.controller)
    try {
      while (!item.controller.signal.aborted && !item.deleted) {
        const resolvedAgent = catalog.get(item.request.profileId, item.request.agent)
        if (!resolvedAgent) {
          return {
            invocationId: item.invocationId,
            status: 'failed',
            failure: failure('AGENT_NOT_FOUND', `Agent "${item.request.agent}" does not exist`),
            sourceRestarts,
            required
          }
        }
        if (!resolvedAgent.enabled) {
          return {
            invocationId: item.invocationId,
            status: 'failed',
            failure: failure('AGENT_DISABLED', `Agent "${resolvedAgent.name}" is disabled`),
            sourceRestarts,
            required
          }
        }
        required =
          item.request.options?.required ??
          resolvedAgent.effective.defaults.required ??
          INVOCATION_DEFAULTS.required
        barrier ??= startBarrier(
          item,
          required,
          item.request.options?.blocksNextTurn ?? resolvedAgent.effective.defaults.blocksNextTurn
        )

        let source: InvocationSourceSnapshot
        try {
          source =
            corrective?.source ??
            (await floor.resolveSource({
              profileId: item.request.profileId,
              chatId: item.request.chatId,
              floor: item.request.floor,
              agent: resolvedAgent,
              options: item.request.options
            }))
          const sourceCurrent = await floor.isSourceCurrent(source, {
            parallelIndependent: item.parallelIndependent
          })
          if (item.stale || !sourceCurrent) {
            if (corrective?.reservedRetry) retryAttemptsConsumed -= 1
            corrective = undefined
            item.stale = false
            sourceRestarts += 1
            continue
          }
        } catch (cause) {
          return {
            invocationId: item.invocationId,
            status: 'failed',
            failure: failure(
              'INPUT_RESOLUTION_FAILED',
              cause instanceof Error ? cause.message : 'Invocation input could not be resolved'
            ),
            sourceRestarts,
            required
          }
        }

        const attemptController = new AbortController()
        item.attemptController = attemptController
        item.stale = false
        const disposeOuter = linkSignal(item.controller.signal, attemptController)
        let execution: HarnessExecutionResult
        // Built per attempt, not per invocation: a restarted attempt re-reads the floor it renders
        // against, so the prompt reflects the source snapshot it is actually executing on.
        const render = promptRenderer?.({
          profileId: item.request.profileId,
          chatId: item.request.chatId,
          floor: item.request.floor
        })
        try {
          execution = await harness.execute({
            invocationId: item.invocationId,
            profileId: item.request.profileId,
            chatId: item.request.chatId,
            floor: item.request.floor,
            agent: {
              definition: resolvedAgent.effective,
              version: resolvedAgent.source.version,
              hash: resolvedAgent.effectiveHash
            },
            input: source.input,
            ...(item.request.toolScope ? { toolScope: item.request.toolScope } : {}),
            options: corrective
              ? { ...invocationOptions(item.request.options), maxRetryAttempts: 0 }
              : invocationOptions(item.request.options),
            ...(source.promptValues ? { promptValues: source.promptValues } : {}),
            ...(source.history !== undefined ? { history: source.history } : {}),
            ...(render ? { render } : {}),
            signal: attemptController.signal,
            ...(corrective
              ? {
                  corrective: {
                    rejectedOutput: corrective.rejectedOutput,
                    failure: corrective.failure
                  }
                }
              : {})
          })
        } catch (cause) {
          if (item.stale) {
            corrective = undefined
            item.stale = false
            sourceRestarts += 1
            continue
          }
          if (item.controller.signal.aborted || item.deleted) {
            return cancelled(item.invocationId, required, sourceRestarts)
          }
          return {
            invocationId: item.invocationId,
            status: 'failed',
            failure: failure(
              'INVOCATION_EXECUTION_FAILED',
              cause instanceof Error ? cause.message : 'Agent Invocation failed'
            ),
            sourceRestarts,
            required
          }
        } finally {
          disposeOuter()
          item.attemptController = undefined
        }
        retryAttemptsConsumed += execution.evidence.attempts.filter(
          (attempt) => attempt.outcome === 'retry'
        ).length

        if (item.controller.signal.aborted || item.deleted) {
          return cancelled(item.invocationId, required, sourceRestarts)
        }
        let stale = item.stale
        try {
          stale ||= !(await floor.isSourceCurrent(source, {
            parallelIndependent: item.parallelIndependent
          }))
        } catch (cause) {
          const sourceFailure = failure(
            'SOURCE_VALIDATION_FAILED',
            cause instanceof Error ? cause.message : 'Invocation source could not be validated'
          )
          harness.commitFailure?.(item.invocationId, sourceFailure)
          return {
            invocationId: item.invocationId,
            status: 'failed',
            failure: sourceFailure,
            sourceRestarts,
            required
          }
        }
        if (stale) {
          if (hasIrreversibleBoundary(execution)) {
            const staleFailure = failure(
              'STALE_NON_TRANSACTIONAL_SOURCE',
              'Invocation input changed after a non-transactional external effect began'
            )
            harness.commitFailure?.(item.invocationId, staleFailure)
            return {
              invocationId: item.invocationId,
              status: 'failed',
              failure: staleFailure,
              sourceRestarts,
              required
            }
          }
          corrective = undefined
          item.stale = false
          sourceRestarts += 1
          continue
        }
        if (!execution.ok) {
          return {
            invocationId: item.invocationId,
            status: execution.failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
            ...(execution.failure.code === 'CANCELLED' ? {} : { failure: execution.failure }),
            sourceRestarts,
            required
          } as InvocationOutcome
        }

        let incorporation: Awaited<ReturnType<InvocationFloorPort['incorporate']>>
        let runCommitted = false
        const commitRun = (): void => {
          if (runCommitted) return
          harness.commitSuccess?.(item.invocationId, execution, {
            status: 'committed',
            operations: execution.stagedOperations.length
          })
          runCommitted = true
        }
        try {
          incorporation = await floor.incorporate({
            invocationId: item.invocationId,
            profileId: item.request.profileId,
            chatId: item.request.chatId,
            floor: item.request.floor,
            agent: resolvedAgent,
            source,
            parallelIndependent: item.parallelIndependent,
            execution,
            commitRun,
            ...(item.request.options?.saveAs ? { saveAs: item.request.options.saveAs } : {})
          })
        } catch (cause) {
          incorporation = {
            status: 'failed',
            failure: {
              code: 'RESULT_INCORPORATION_FAILED',
              message: cause instanceof Error ? cause.message : 'Agent Result incorporation failed',
              retryable: true
            }
          }
        }
        if (item.controller.signal.aborted || item.deleted || incorporation.status === 'deleted') {
          return cancelled(item.invocationId, required, sourceRestarts)
        }
        if (incorporation.status === 'stale') {
          if (hasIrreversibleBoundary(execution)) {
            const staleFailure = failure(
              'STALE_NON_TRANSACTIONAL_SOURCE',
              'Result incorporation conflicted after a non-transactional external effect began'
            )
            harness.commitFailure?.(item.invocationId, staleFailure)
            return {
              invocationId: item.invocationId,
              status: 'failed',
              failure: staleFailure,
              sourceRestarts,
              required
            }
          }
          corrective = undefined
          item.stale = false
          sourceRestarts += 1
          continue
        }
        if (incorporation.status === 'failed') {
          const maximumRetries =
            item.request.options?.maxRetryAttempts ??
            resolvedAgent.effective.defaults.maxRetryAttempts ??
            INVOCATION_DEFAULTS.maxRetryAttempts
          if (
            incorporation.failure.retryable &&
            !hasIrreversibleBoundary(execution) &&
            retryAttemptsConsumed < maximumRetries
          ) {
            retryAttemptsConsumed += 1
            const delayMs =
              item.request.options?.retryDelayMs ??
              resolvedAgent.effective.defaults.retryDelayMs ??
              INVOCATION_DEFAULTS.retryDelayMs
            await waitForRetry(delayMs, item.controller.signal)
            if (item.controller.signal.aborted || item.deleted) {
              return cancelled(item.invocationId, required, sourceRestarts)
            }
            corrective = {
              source,
              rejectedOutput:
                execution.result === undefined ? '' : JSON.stringify(execution.result),
              failure: incorporation.failure,
              reservedRetry: true
            }
            continue
          }
          harness.commitFailure?.(item.invocationId, incorporation.failure, {
            status: 'failed',
            operations: execution.stagedOperations.length,
            message: incorporation.failure.message
          })
          return {
            invocationId: item.invocationId,
            status: 'failed',
            failure: incorporation.failure,
            sourceRestarts,
            required
          }
        }
        // Lightweight test/embedding ports may not own persistence. The production Floor port calls
        // this inside its session-DB transaction before returning committed.
        commitRun()
        return {
          invocationId: item.invocationId,
          status: 'succeeded',
          result: execution.result,
          sourceRestarts,
          required
        }
      }
      return cancelled(item.invocationId, required, sourceRestarts)
    } finally {
      disposeRequestSignal()
    }
  }

  const pumpLane = (lane: string): void => {
    if (runningLanes.has(lane)) return
    const queue = lanes.get(lane)
    const item = queue?.[0]
    if (!queue || !item) return
    runningLanes.add(lane)
    const complete = (outcome: InvocationOutcome): void => {
      finishBarrier(item, barrierMap(item.request.chatId).get(item.invocationId), outcome)
      item.finished = true
      item.resolve(outcome)
      queue.shift()
      runningLanes.delete(lane)
      if (queue.length === 0) lanes.delete(lane)
      else pumpLane(lane)
    }
    void runQueued(item).then(complete, (cause: unknown) =>
      complete({
        invocationId: item.invocationId,
        status: 'failed',
        failure: failure(
          'INVOCATION_RUNTIME_FAILED',
          cause instanceof Error ? cause.message : 'Invocation Runtime failed'
        ),
        sourceRestarts: 0,
        required: item.request.options?.required ?? INVOCATION_DEFAULTS.required
      })
    )
  }

  const enqueue = (
    request: InvocationRequest,
    internal: { planId?: string; parallelIndependent?: boolean } = {}
  ): InvocationPromise => {
    const identity = identityFor(request)
    const duplicate = identities.get(identity)
    if (duplicate) {
      if (internal.planId) plans.get(internal.planId)?.invocations.add(duplicate.invocationId)
      return duplicate.promise
    }
    const invocationId = createId()
    let resolve!: (outcome: InvocationOutcome) => void
    const promise = new Promise<InvocationOutcome>((done) => {
      resolve = done
    }) as InvocationPromise
    Object.defineProperty(promise, 'invocationId', {
      value: invocationId,
      enumerable: true
    })
    const item: QueuedInvocation = {
      invocationId,
      identity,
      request,
      parallelIndependent: internal.parallelIndependent ?? false,
      ...(internal.planId ? { planId: internal.planId } : {}),
      controller: new AbortController(),
      stale: false,
      deleted: false,
      finished: false,
      promise,
      resolve
    }
    identities.set(identity, item)
    invocations.set(invocationId, item)
    if (internal.planId) plans.get(internal.planId)?.invocations.add(invocationId)
    const lane = laneFor(request)
    const queue = lanes.get(lane) ?? []
    const active = runningLanes.has(lane) ? queue[0] : undefined
    if (active && request.floor < active.request.floor) {
      const outcome: InvocationFailure = {
        invocationId,
        status: 'failed',
        failure: failure(
          'OLDER_FLOOR_ALREADY_EXECUTING',
          `Floor ${request.floor} cannot enter the Agent Lane while newer floor ${active.request.floor} is executing`
        ),
        sourceRestarts: 0,
        required: request.options?.required ?? INVOCATION_DEFAULTS.required
      }
      item.finished = true
      identities.delete(identity)
      invocations.delete(invocationId)
      resolve(outcome)
      return promise
    }
    const start = active ? 1 : 0
    let index = start
    while (index < queue.length && queue[index].request.floor <= request.floor) index += 1
    queue.splice(index, 0, item)
    lanes.set(lane, queue)
    pumpLane(lane)
    return promise
  }

  const cancelInvocation = (invocationId: string): boolean => {
    const item = invocations.get(invocationId)
    if (!item || item.finished || item.controller.signal.aborted) return false
    item.controller.abort('CANCELLED')
    item.attemptController?.abort('CANCELLED')
    harness.stop(invocationId)
    return true
  }

  const cancelPlan = (planId: string): boolean => {
    const plan = plans.get(planId)
    if (!plan || plan.controller.signal.aborted) return false
    plan.controller.abort('CANCELLED')
    for (const invocationId of plan.invocations) cancelInvocation(invocationId)
    return true
  }

  const runPlan = (request: InvocationPlanRequest): InvocationPlanPromise => {
    const parsed = parseInvocationPlan(request.plan)
    if (!parsed.ok) {
      throw new InvocationRuntimeError(
        'INVALID_PLAN',
        parsed.errors.map((error) => error.message).join('; '),
        parsed.errors
      )
    }
    const plan = parsed.value
    const seen = new Set<string>()
    for (const step of plan.steps) {
      const calls = 'parallel' in step ? step.parallel : [step]
      for (const call of calls) {
        const name = normalizeAgentName(call.agent)
        if (seen.has(name)) {
          throw new InvocationRuntimeError(
            'INVALID_PLAN',
            `Agent "${call.agent}" appears more than once in an Invocation Plan`
          )
        }
        seen.add(name)
      }
    }
    const floorNumber = request.floor ?? plan.floor
    if (floorNumber === undefined) {
      throw new InvocationRuntimeError('INVALID_PLAN', 'Invocation Plan floor is required')
    }
    const planId = createId()
    const controller = new AbortController()
    const dispose = linkSignal(request.signal, controller)
    plans.set(planId, { controller, invocations: new Set() })

    const promise = (async () => {
      const outcomes: InvocationOutcome[] = []
      try {
        for (const step of plan.steps) {
          if (controller.signal.aborted) {
            return { planId, status: 'cancelled', outcomes }
          }
          const calls = 'parallel' in step ? step.parallel : [step]
          const stepOutcomes = await Promise.all(
            calls.map((call) =>
              enqueue(
                {
                  profileId: request.profileId,
                  chatId: request.chatId,
                  floor: floorNumber,
                  agent: call.agent,
                  options: callOptions(call),
                  ...(request.toolScope ? { toolScope: request.toolScope } : {}),
                  signal: controller.signal
                },
                {
                  planId,
                  parallelIndependent: 'parallel' in step
                }
              )
            )
          )
          outcomes.push(...stepOutcomes)
          if (controller.signal.aborted) {
            return { planId, status: 'cancelled', outcomes }
          }
          if (stepOutcomes.some((outcome) => outcome.status === 'failed' && outcome.required)) {
            return { planId, status: 'failed', outcomes }
          }
        }
        return { planId, status: 'succeeded', outcomes }
      } finally {
        dispose()
        plans.delete(planId)
      }
    })() as InvocationPlanPromise
    Object.defineProperty(promise, 'planId', { value: planId, enumerable: true })
    return promise
  }

  const getNextTurnBarrier = (chatId: string): NextTurnBarrierState => {
    const current = [...(barriers.get(chatId)?.values() ?? [])]
    const pending = current.filter((barrier) => !barrier.failure).length
    const failures = current.flatMap((barrier) => (barrier.failure ? [barrier.failure] : []))
    if (pending > 0) return { status: 'pending', pending, failures }
    if (failures.length > 0) return { status: 'failed', pending: 0, failures }
    return { status: 'clear', pending: 0, failures: [] }
  }

  const cancelFloors = (chatId: string, fromFloor: number): void => {
    const affectedPlans = new Set<string>()
    for (const item of invocations.values()) {
      if (item.request.chatId !== chatId || item.request.floor < fromFloor) continue
      item.deleted = true
      if (item.planId) affectedPlans.add(item.planId)
      cancelInvocation(item.invocationId)
      identities.delete(item.identity)
      invocations.delete(item.invocationId)
      barrierMap(chatId).delete(item.invocationId)
    }
    for (const planId of affectedPlans) cancelPlan(planId)
  }

  return {
    run: enqueue,
    runPlan,
    cancelInvocation,
    cancelPlan,
    cancelFloors,
    deleteFloors(chatId, fromFloor) {
      cancelFloors(chatId, fromFloor)
      runStore?.deleteFromFloor(chatId, fromFloor)
    },
    invalidateSources(chatId, throughFloor) {
      for (const item of invocations.values()) {
        if (
          item.request.chatId !== chatId ||
          item.request.floor < throughFloor ||
          item.parallelIndependent ||
          item.finished ||
          item.controller.signal.aborted
        ) {
          continue
        }
        item.stale = true
        item.attemptController?.abort('STALE_SOURCE')
      }
    },
    getNextTurnBarrier,
    hasActiveWork() {
      // Union of every live-work container. `lanes` holds the queued + currently-running items per
      // lane (an entry is shifted out and the lane dropped when it completes); `plans` holds plans
      // still stepping between invocations. `invocations` is NOT pruned on normal completion — it
      // is the identity/dedupe ledger — so it is scanned by the `finished` flag, never by size.
      if (plans.size > 0 || lanes.size > 0) return true
      for (const item of invocations.values()) if (!item.finished) return true
      return false
    },
    async waitForNextTurnBarriers(chatId) {
      const current = [...(barriers.get(chatId)?.values() ?? [])]
      await Promise.all(current.map((barrier) => barrier.settled))
      return getNextTurnBarrier(chatId)
    },
    shutdown() {
      if (shutDown) return
      shutDown = true
      for (const plan of plans.values()) plan.controller.abort('APP_SHUTDOWN')
      harness.shutdown?.()
      for (const item of invocations.values()) {
        item.controller.abort('APP_SHUTDOWN')
        item.attemptController?.abort('APP_SHUTDOWN')
      }
    }
  }
}
