import type {
  AgentDefinition,
  AgentPromptOrigin,
  InvocationOptions,
  JsonObject,
  JsonValue,
  PromptMessage
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
  /** Zero-based authored prompt indexes whose rendered text depends on mutable prompt state. The
   *  upstream planner owns template syntax; the Harness only consumes this explicit cache hint. */
  volatilePromptIndices?: number[]
  /**
   * Prompt messages that SUBSTITUTE for `definition.prompt` (ADR 0021, slices 3/4). A preset Agent's
   * prompt is assembled upstream — card, persona, world info, opt-in history, then the Agent's own
   * `prompt` as the task instruction — and arrives here already ordered and already rendered.
   *
   * The Harness stays free of prompt policy: it does not know a preset was involved, only that it was
   * handed messages instead of reading them off the definition. Everything else (harness policy line,
   * serialized input, addendum, corrective turn, tools, retries) is unchanged, which is why a preset
   * Agent still runs the FULL `execute` path and never `executePrepared`.
   *
   * Deliberately NOT on `HarnessPreparedRequest`: Classic's prepared path must stay renderer-free.
   */
  prompt?: PromptMessage[]
  /**
   * Fired ONCE, synchronously, with the exact messages the attempt log was built from — before any
   * provider call. This is the ONLY way an observer can obtain the rendered prompt: templates read
   * mutable state (`getvar`/`getMessageVar`), so a second `buildAttemptLog` by the caller would
   * produce a prompt that merely RESEMBLES the dispatched one. Run Records are exact evidence, so
   * they subscribe here instead of re-rendering.
   *
   * Each message carries its coarse provenance with the provider bytes it describes. The origin is
   * stripped before dispatch, so observers cannot accidentally misalign parallel arrays.
   */
  onPromptBuilt?: (messages: AttributedProviderMessage[]) => void
  signal?: AbortSignal
  yssVocabulary?: SceneVocabulary
  corrective?: {
    rejectedOutput: string
    failure: HarnessFailure
  }
}

export interface AttributedProviderMessage extends ProviderMessage {
  origin: AgentPromptOrigin
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
  /** Step-0 token attribution for this attempt (Microscope-lite D2). Always populated once the attempt
   *  reaches its first provider step; absent only if it failed before step 0 (e.g. pre-loop abort). */
  contextBudget?: ContextBudgetAttribution
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
