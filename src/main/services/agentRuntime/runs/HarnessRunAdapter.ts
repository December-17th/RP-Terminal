import {
  resolveInvocationOptions,
  type AgentDefinition,
  type AgentRunMessage,
  type AgentRunReplayOutcome,
  type InvocationOptions,
  type JsonObject,
  type JsonValue
} from '../../../../shared/agentRuntime'
import type { SceneVocabulary } from '../../../../shared/yuzu/sceneSchema'
import {
  createAgentHarness,
  DEFAULT_HARNESS_POLICY,
  type AgentHarness,
  type CreateAgentHarnessOptions,
  type HarnessExecutionResult,
  type HarnessFailure
} from '../harness'
import { buildAttemptLog } from '../harness/attemptLog'
import type { AgentRunStore } from './AgentRunStore'

export interface AgentDefinitionSnapshot {
  definition: AgentDefinition
  version: string | number
  hash: string
}

export interface HarnessRunRequest {
  invocationId: string
  profileId: string
  chatId: string
  floor: number
  agent: AgentDefinitionSnapshot
  input: JsonObject
  options?: Omit<InvocationOptions, 'floor' | 'input' | 'inputBindings'>
  promptValues?: Record<string, JsonValue>
  history?: JsonValue
  signal?: AbortSignal
  yssVocabulary?: SceneVocabulary
  /** Narrow fresh-context input used only after transactional incorporation/replay rejection. */
  corrective?: {
    rejectedOutput: string
    failure: HarnessFailure
  }
}

export interface HarnessRunAdapter {
  execute(request: HarnessRunRequest): Promise<HarnessExecutionResult>
  commitSuccess(
    invocationId: string,
    execution: Extract<HarnessExecutionResult, { ok: true }>,
    replay: AgentRunReplayOutcome
  ): void
  commitFailure(
    invocationId: string,
    failure: HarnessFailure,
    replay?: AgentRunReplayOutcome
  ): void
  stop(invocationId: string): boolean
  shutdown(): void
}

export interface CreateHarnessRunAdapterOptions extends Omit<
  CreateAgentHarnessOptions,
  'harnessPolicy'
> {
  runStore: AgentRunStore
  harnessPolicy?: string
}

interface Link {
  signal: AbortSignal
  dispose(): void
}

const linkSignals = (signals: Array<AbortSignal | undefined>): Link => {
  const controller = new AbortController()
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  const listeners = new Map<AbortSignal, () => void>()
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  for (const signal of active) {
    if (signal.aborted) {
      abortFrom(signal)
      break
    }
    const listener = (): void => abortFrom(signal)
    listeners.set(signal, listener)
    signal.addEventListener('abort', listener, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener)
      }
      listeners.clear()
    }
  }
}

const recordMessages = (
  messages: Array<{ role: AgentRunMessage['role']; content: string }>
): AgentRunMessage[] => messages.map(({ role, content }) => ({ role, content }))

const unexpectedFailure = (cause: unknown): HarnessFailure => ({
  code: 'HARNESS_EXECUTION_FAILED',
  message: cause instanceof Error ? cause.message : 'Agent Harness execution failed',
  retryable: false
})

/**
 * The sole production adapter between AgentHarness and AgentRunStore.
 *
 * It deliberately excludes lanes, floor replay, and result incorporation. Later InvocationRuntime
 * composition can consume the returned staged operations without changing this observation seam.
 */
export const createHarnessRunAdapter = ({
  runStore,
  harnessPolicy = DEFAULT_HARNESS_POLICY,
  ...harnessOptions
}: CreateHarnessRunAdapterOptions): HarnessRunAdapter => {
  const harness: AgentHarness = createAgentHarness({ ...harnessOptions, harnessPolicy })
  const handles = new Map<string, { signal: AbortSignal }>()
  const evidenceByInvocation = new Map<string, HarnessExecutionResult['evidence']>()

  const combinedEvidence = (
    invocationId: string,
    evidence: HarnessExecutionResult['evidence']
  ): HarnessExecutionResult['evidence'] => {
    const previous = evidenceByInvocation.get(invocationId)
    const combined = previous
      ? {
          ...previous,
          ...evidence,
          attempts: [...previous.attempts, ...evidence.attempts]
        }
      : evidence
    evidenceByInvocation.set(invocationId, combined)
    return combined
  }

  return {
    async execute(request) {
      const resolved = resolveInvocationOptions(request.agent.definition, request.options)
      if (!resolved.ok) {
        throw new Error(resolved.errors.map((error) => error.message).join('; '))
      }
      const harnessRequest = {
        definition: request.agent.definition,
        input: request.input,
        profileId: request.profileId,
        options: resolved.value,
        ...(request.promptValues ? { promptValues: request.promptValues } : {}),
        ...(request.history !== undefined ? { history: request.history } : {}),
        ...(request.yssVocabulary ? { yssVocabulary: request.yssVocabulary } : {}),
        ...(request.corrective ? { corrective: request.corrective } : {})
      }
      const prompt = buildAttemptLog(
        request.agent.definition,
        harnessRequest,
        resolved.value,
        harnessPolicy
      )
      const renderedPrompt = prompt.ok
        ? recordMessages([...prompt.immutablePrefix, ...prompt.attemptLog])
        : []
      let handle = handles.get(request.invocationId)
      if (!handle) {
        handle = runStore.create({
          invocationId: request.invocationId,
          profileId: request.profileId,
          chatId: request.chatId,
          floor: request.floor,
          agentVersion: request.agent.version,
          agentHash: request.agent.hash,
          definition: request.agent.definition,
          config: resolved.value,
          input: request.input,
          renderedPrompt,
          history: request.history ?? null
        })
        handles.set(request.invocationId, handle)
      } else {
        runStore.replaceSource(request.invocationId, {
          input: request.input,
          renderedPrompt,
          history: request.history ?? null
        })
      }
      const linked = linkSignals([handle.signal, request.signal])
      try {
        const execution = await harness.execute({ ...harnessRequest, signal: linked.signal })
        const evidence = combinedEvidence(request.invocationId, execution.evidence)
        runStore.update(request.invocationId, evidence)
        if (!execution.ok && linked.signal.reason !== 'STALE_SOURCE') {
          const cancelled = linked.signal.aborted || execution.failure.code === 'CANCELLED'
          runStore.finalize(request.invocationId, {
            status: cancelled ? 'cancelled' : 'failed',
            failure: execution.failure,
            evidence,
            replay: { status: 'discarded', operations: 0 }
          })
          handles.delete(request.invocationId)
          evidenceByInvocation.delete(request.invocationId)
        }
        return execution
      } catch (cause) {
        if (linked.signal.reason === 'STALE_SOURCE') throw cause
        runStore.finalize(request.invocationId, {
          status: linked.signal.aborted ? 'cancelled' : 'failed',
          failure: linked.signal.aborted
            ? {
                code: 'CANCELLED',
                message: 'Agent Invocation cancelled',
                retryable: false
              }
            : unexpectedFailure(cause),
          evidence: { attempts: [] },
          replay: { status: 'discarded', operations: 0 }
        })
        handles.delete(request.invocationId)
        evidenceByInvocation.delete(request.invocationId)
        throw cause
      } finally {
        linked.dispose()
      }
    },
    commitSuccess(invocationId, execution, replay) {
      runStore.finalize(invocationId, {
        status: 'succeeded',
        result: execution.result,
        evidence: evidenceByInvocation.get(invocationId) ?? execution.evidence,
        replay
      })
      handles.delete(invocationId)
      evidenceByInvocation.delete(invocationId)
    },
    commitFailure(invocationId, failure, replay = { status: 'failed', operations: 0 }) {
      runStore.finalize(invocationId, {
        status: failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
        failure,
        evidence: evidenceByInvocation.get(invocationId) ?? { attempts: [] },
        replay
      })
      handles.delete(invocationId)
      evidenceByInvocation.delete(invocationId)
    },
    stop(invocationId) {
      const stopped = runStore.cancel(invocationId).cancelled
      if (stopped) {
        handles.delete(invocationId)
        evidenceByInvocation.delete(invocationId)
      }
      return stopped
    },
    shutdown() {
      runStore.shutdown()
      handles.clear()
      evidenceByInvocation.clear()
    }
  }
}
