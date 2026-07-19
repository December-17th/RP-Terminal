import type {
  AgentDefinition,
  InvocationOptions,
  JsonObject,
  JsonValue
} from '../../../../shared/agentRuntime'
import type { SceneVocabulary } from '../../../../shared/yuzu/sceneSchema'
import type {
  ProviderDispatch,
  ProviderCacheUsage,
  ProviderEvent,
  ProviderMessage,
  ProviderPresetSnapshot,
  ProviderRateLimit,
  ProviderResult,
  ProviderToolCall,
  ProviderToolDefinition,
  ProviderUsage,
  ResolvedProviderDispatch
} from '../provider'
import type { StagedToolOperation, ToolExecutionScope, ToolRegistry } from '../tools'

export interface HarnessExecuteRequest {
  definition: AgentDefinition
  input: JsonObject
  profileId: string
  /** Main-derived mounted-card scope for resolving live card Tool Bindings. */
  toolScope?: ToolExecutionScope
  options?: InvocationOptions
  promptValues?: Record<string, JsonValue>
  history?: JsonValue
  /**
   * Prompt-text renderer injected by the caller that OWNS prompt policy (ADR 0021): the Harness
   * never imports the template engine, it only applies the function it is handed to the authored
   * text of each prompt message. Absent → text is used verbatim. Must never throw; a renderer that
   * fails is expected to return its input, and `buildAttemptLog` guards that contract anyway.
   */
  render?: (text: string) => string
  signal?: AbortSignal
  yssVocabulary?: SceneVocabulary
  corrective?: {
    rejectedOutput: string
    failure: HarnessFailure
  }
}

export interface ContextBudgetAttribution {
  limit: number
  total: number
  regions: Array<{ region: string; tokens: number }>
}

export interface ToolEvidence {
  call: ProviderToolCall
  step?: number
  index?: number
  arguments?: JsonObject
  status?: 'failure'
  error?: Pick<HarnessFailure, 'code' | 'message'>
  durationMs?: number
  transactionMode?: AgentDefinition['tools'][number]['transactionMode']
  irreversibleBoundaryCrossed?: boolean
  result?: JsonValue
  projectedContent?: string
  projectedTokens?: number
  projectionLimit?: number
  truncated?: boolean
  repaired?: 'wrong-channel' | 'truncated-json'
  suppressed?: boolean
}

export interface IrreversibleBoundaryEvidence {
  step: number
  toolCall: {
    id: string
    name: string
    index: number
  }
}

export interface HarnessAttemptEvidence {
  attempt: number
  outcome: 'success' | 'retry' | 'failure' | 'cancelled'
  providerCalls: number
  immutablePrefix: ProviderMessage[]
  toolSchemas: ProviderToolDefinition[]
  appendOnlyLog: ProviderMessage[]
  tools: ToolEvidence[]
  usage: ProviderUsage[]
  cache: ProviderCacheUsage[]
  latencyMs: number[]
  rateLimits: ProviderRateLimit[]
  error?: HarnessFailure
  repairs?: Array<'wrong-channel-tool-call' | 'truncated-json'>
  rejectedOutput?: string
  discardedOperations?: number
  irreversibleBoundary?: boolean
  irreversibleBoundaries?: IrreversibleBoundaryEvidence[]
}

export interface HarnessEvidence {
  preset?: Readonly<ProviderPresetSnapshot>
  attempts: HarnessAttemptEvidence[]
  contextBudget?: ContextBudgetAttribution
}

export interface HarnessFailure {
  code: string
  message: string
  retryable: boolean
  contextBudget?: ContextBudgetAttribution
}

export type HarnessExecutionResult =
  | {
      ok: true
      result: JsonValue | undefined
      stagedOperations: StagedToolOperation[]
      evidence: HarnessEvidence
    }
  | {
      ok: false
      failure: HarnessFailure
      stagedOperations: []
      evidence: HarnessEvidence
    }

/**
 * Internal prepared-request Interface (Classic Narrator first slice).
 *
 * The caller has ALREADY produced the final ordered provider messages (assembly, provider shaping,
 * and late dispatch transforms all ran exactly once upstream) and has ALREADY resolved its own
 * connection/preset. The Harness therefore adds nothing to the wire: no harness-policy message, no
 * serialized-input message, no prompt rendering, no history, no addendum, no corrective turn, and no
 * tools. It executes exactly ONE text step and owns no retry — the caller's resilient-call policy
 * keeps that role.
 */
export interface HarnessPreparedRequest {
  /** Caller-resolved dispatch. The Harness never re-resolves a provider on this path. */
  provider: ResolvedProviderDispatch
  /** The final, ordered, provider-bound messages. Sent through untouched. */
  messages: ProviderMessage[]
  signal?: AbortSignal
  onEvent?: (event: ProviderEvent) => void
}

export interface AgentHarness {
  execute(request: HarnessExecuteRequest): Promise<HarnessExecutionResult>
  /**
   * Returns the provider result directly. No `HarnessEvidence` is assembled: the byte-accurate
   * evidence for this path is already the caller's `log('request', …)` at prompt assembly and
   * `log('response', …, raw)` in `callModel`, so a second record would only be allocated and dropped.
   */
  executePrepared(request: HarnessPreparedRequest): Promise<ProviderResult>
}

export interface CreateAgentHarnessOptions {
  providerDispatch: ProviderDispatch
  toolRegistry: ToolRegistry
  harnessPolicy?: string
  estimateTokens?: (content: string) => number
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  /** Internal deterministic override for budget tests; invocation authors cannot set this. */
  contextWindowTokensForTest?: number
}
