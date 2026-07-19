import {
  resolveInvocationOptions,
  type AgentDefinition,
  type AgentRunMessage,
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
}

export interface HarnessRunAdapter {
  execute(request: HarnessRunRequest): Promise<HarnessExecutionResult>
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
        ...(request.yssVocabulary ? { yssVocabulary: request.yssVocabulary } : {})
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
      const handle = runStore.create({
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
      const linked = linkSignals([handle.signal, request.signal])
      try {
        const execution = await harness.execute({ ...harnessRequest, signal: linked.signal })
        runStore.update(request.invocationId, execution.evidence)
        if (execution.ok) {
          runStore.finalize(request.invocationId, {
            status: 'succeeded',
            result: execution.result,
            evidence: execution.evidence,
            replay: {
              status: 'not-applicable',
              operations: execution.stagedOperations.length
            }
          })
        } else {
          const cancelled = linked.signal.aborted || execution.failure.code === 'CANCELLED'
          runStore.finalize(request.invocationId, {
            status: cancelled ? 'cancelled' : 'failed',
            failure: execution.failure,
            evidence: execution.evidence,
            replay: { status: 'discarded', operations: 0 }
          })
        }
        return execution
      } catch (cause) {
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
        throw cause
      } finally {
        linked.dispose()
      }
    },
    stop(invocationId) {
      return runStore.cancel(invocationId).cancelled
    },
    shutdown() {
      runStore.shutdown()
    }
  }
}
