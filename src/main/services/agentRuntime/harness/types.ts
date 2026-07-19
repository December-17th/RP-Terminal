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
  ProviderMessage,
  ProviderPresetSnapshot,
  ProviderRateLimit,
  ProviderToolCall,
  ProviderToolDefinition,
  ProviderUsage
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

export interface AgentHarness {
  execute(request: HarnessExecuteRequest): Promise<HarnessExecutionResult>
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
