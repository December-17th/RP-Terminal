import type {
  AgentDefinition,
  EffectiveInvocationOptions,
  JsonObject,
  JsonValue,
  NotificationPolicy
} from './types'

export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'degraded'

/**
 * Coarse provenance of a rendered-prompt message (Microscope-lite D3). Deliberately coarse — it says
 * WHICH stage of prompt assembly produced a message, not the fine-grained card/persona/lorebook/history
 * split inside an assembled blob (that would require threading section labels through `assemblePrompt`).
 *
 * · `harness-policy`    — the harness policy line prepended to every attempt.
 * · `agent-prompt`      — a message rendered from the Agent's own `definition.prompt` (messages Agent).
 * · `assembled-preset`  — a message substituted in from an upstream-assembled preset stack (preset Agent).
 * · `input`             — the serialized invocation input.
 * · `addendum`          — an invocation-option addendum appended after the input.
 */
export type AgentPromptOrigin =
  | 'harness-policy'
  | 'agent-prompt'
  | 'assembled-preset'
  | 'input'
  | 'addendum'

export interface AgentRunMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
  toolCalls?: JsonValue[]
  /** Coarse provenance of this message (D3). Optional so pre-Microscope records still render. */
  origin?: AgentPromptOrigin
}

export interface AgentRunAttempt {
  attempt: number
  outcome: 'success' | 'retry' | 'failure' | 'cancelled'
  providerCalls: number
  immutablePrefix: AgentRunMessage[]
  appendOnlyLog: AgentRunMessage[]
  messages: AgentRunMessage[]
  toolSchemas: JsonValue[]
  repairs: string[]
  tools: JsonValue[]
  usage: Array<{ inputTokens: number; outputTokens: number }>
  cache: Array<{ readTokens: number; writeTokens: number }>
  latencyMs: number[]
  rateLimits: JsonValue[]
  error?: AgentRunFailure
  rejectedOutput?: string
  discardedOperations?: number
  irreversibleBoundary?: boolean
  irreversibleBoundaries?: JsonValue[]
  /** Step-0 token attribution for THIS attempt (Microscope-lite D2). Additive; carried through the
   *  store's generic sanitize spread so the viewer can show budget growth across attempts. */
  contextBudget?: AgentRunContextBudget
}

export interface AgentRunContextBudget {
  limit: number
  total: number
  regions: Array<{ region: string; tokens: number }>
}

export interface AgentRunFailure {
  code: string
  message: string
  retryable: boolean
  contextBudget?: AgentRunContextBudget
}

export interface AgentRunReplayOutcome {
  status: 'not-applicable' | 'committed' | 'discarded' | 'failed'
  operations: number
  message?: string
}

export interface AgentRunMetrics {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  latencyMs: number
  retries: number
  rateLimits: JsonValue[]
}

export interface AgentRunRecord {
  invocationId: string
  profileId: string
  chatId: string
  floor: number
  agentName: string
  agentVersion: string | number
  agentHash: string
  status: AgentRunStatus
  startedAt: string
  finishedAt?: string
  notification: NotificationPolicy
  definition: AgentDefinition
  config: EffectiveInvocationOptions
  input: JsonObject
  renderedPrompt: AgentRunMessage[]
  history: JsonValue
  contracts: {
    input: JsonObject
    result: AgentDefinition['result']
    tools: AgentDefinition['tools']
  }
  provider?: {
    presetId: string
    presetName: string
    provider: string
    endpoint: string
    model: string
    parameters: JsonObject
  }
  attempts: AgentRunAttempt[]
  evidence: JsonValue
  contextBudget?: AgentRunContextBudget
  result?: JsonValue
  failure?: AgentRunFailure
  replay: AgentRunReplayOutcome
  metrics: AgentRunMetrics
  warnings: string[]
}

export interface AgentRunSummary {
  invocationId: string
  chatId: string
  floor: number
  agentName: string
  status: AgentRunStatus
  startedAt: string
  finishedAt?: string
  notification: NotificationPolicy
  failure?: AgentRunFailure
  model?: string
  metrics: AgentRunMetrics
}

export type AgentRunEvent =
  | { type: 'started' | 'updated' | 'finished'; run: AgentRunSummary }
  | { type: 'deleted'; invocationId: string; chatId: string; floor: number }

export interface AgentRunCancelResult {
  invocationId: string
  cancelled: boolean
}

/** Opaque main-process request envelopes used by the trusted renderer preload. */
export interface AgentRunChatRequest {
  profileId: string
  chatId: string
}

export interface AgentRunInvocationRequest extends AgentRunChatRequest {
  invocationId: string
}
