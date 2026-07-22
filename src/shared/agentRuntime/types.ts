export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type JsonSchema = JsonObject

export type FullVariablesPath = `variables.${string}`
export type ResultSlotPath = `variables.__rpt.agent_results.${string}`

export type InputBindingSource =
  | { type: 'literal'; value: JsonValue }
  | { type: 'input' }
  | { type: 'variables'; path: FullVariablesPath }
  | { type: 'result'; path: ResultSlotPath }

export interface InputBinding {
  source: InputBindingSource
  default?: JsonValue
}

export type InputBindings = Record<string, InputBinding>

export type PromptBindingSource =
  | { type: 'input' }
  | { type: 'history' }
  | { type: 'variables'; path: FullVariablesPath }
  | { type: 'result'; path: ResultSlotPath }

export type PromptSegment =
  | { type: 'text'; text: string }
  | { type: 'binding'; source: PromptBindingSource; default?: JsonValue }

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: PromptSegment[]
}

export type ResultContract =
  | { mode: 'text'; saveAs?: ResultSlotPath; validator?: 'yss' | 'yuzu-annotated-floor' }
  | { mode: 'json'; schema: JsonSchema; saveAs?: ResultSlotPath }
  | { mode: 'tools-only' }

export type ProcessorOutputContract =
  | { mode: 'text' }
  | { mode: 'json'; schema: JsonSchema }

export interface AgentPreprocessor {
  code: string
}

export interface AgentPostprocessor {
  code: string
  output: ProcessorOutputContract
}

export interface AgentProcessing {
  runtime: 'rpt-processor-v1'
  preprocess?: AgentPreprocessor
  postprocess?: AgentPostprocessor
}

export interface AgentProcessingWarning {
  phase: 'preprocess' | 'postprocess'
  code: 'SCRIPT_FAILED' | 'OUTPUT_INVALID' | 'LIMIT_EXCEEDED'
  message: string
}

export type ToolTransactionMode = 'read-only' | 'transactional' | 'non-transactional'

export interface AgentToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
  required: boolean
  transactionMode: ToolTransactionMode
  parallelSafe: boolean
  resultMaxTokens?: number
}

export interface HistoryPolicy {
  maxFloors?: number
  maxTokens?: number
  includeUserMessages: boolean
  includePlayerResults: boolean
}

export interface GenerationParameters {
  temperature?: number
  max_tokens?: number
  top_p?: number
  top_k?: number
  frequency_penalty?: number
  presence_penalty?: number
  repetition_penalty?: number
  min_p?: number
  top_a?: number
  stop?: string[]
}

/**
 * The lossless ST prompt-preset envelope (ADR 0018) embedded in an Agent Definition so the Agent
 * stays self-contained and portable. Opaque at the contract layer: the envelope's internals are the
 * preset layer's business, and modelling them here would drag preset code across the shared/main
 * module boundary. Consumers parse it themselves.
 */
export type AgentPresetEnvelope = JsonObject

/**
 * Entry-level narrowing applied after lorebook selection. Names match a lorebook entry's `comment`
 * (its ST title). `exclude` is applied after `include`.
 */
export interface AgentLorebookEntryFilter {
  include?: string[]
  exclude?: string[]
}

/**
 * Which lorebooks feed assembly: the session's normal set, or an explicit list of lorebooks by name
 * (never by user-local id — a portable Agent cannot reference one).
 */
export type AgentLorebookSelection =
  | { mode: 'session'; entries?: AgentLorebookEntryFilter }
  | { mode: 'explicit'; lorebooks: string[]; entries?: AgentLorebookEntryFilter }

/**
 * A prompt preset bundled into an Agent Definition (ADR 0021). Its presence turns on full
 * preset-driven assembly; the Definition's `prompt` remains the Agent's task instruction.
 */
export interface AgentPresetBundle {
  preset: AgentPresetEnvelope
  generationParameters?: GenerationParameters
  lorebooks?: AgentLorebookSelection
}

export type NotificationPolicy = 'none' | 'failure' | 'completion'

/**
 * The ONLY declarative trigger kind (execution-plan M3, decision D1(a)): re-evaluate the Agent at
 * each new-floor commit and fire when at least `everyNFloors` floors have elapsed since it last ran.
 * There is deliberately no other kind — no timers, no cron, no variable-watching. The schema rejects
 * any other trigger shape at parse time, so the runtime never has to defend against one.
 */
export interface AgentTrigger {
  onFloorCommitted: { everyNFloors: number }
}

/** The player-facing roles an Agent can be bound to. Re-exported by the main-side AgentCatalog. */
export type AgentRole = 'classic.narrator' | 'yuzu.sceneDirector'

export interface InvocationDefaults {
  required: boolean
  maxSteps: number
  maxRetryAttempts: number
  retryDelayMs: number
  blocksNextTurn: boolean
  toolResultMaxTokens: number
  history?: HistoryPolicy
  generationParameters?: GenerationParameters
  notification: NotificationPolicy
}

export interface AgentDefinition {
  format: 'rpt-agent'
  formatVersion: 1 | 2
  name: string
  description?: string
  prompt: PromptMessage[]
  /** Optional bundled prompt preset (ADR 0021). Absent for a plain messages Agent. */
  preset?: AgentPresetBundle
  inputSchema: JsonSchema
  result: ResultContract
  /** Portable, capability-free processing scripts. Only valid in formatVersion 2. */
  processing?: AgentProcessing
  tools: AgentToolDefinition[]
  modelHint?: string
  /** Optional declarative cadence trigger (M3). Absent for an Agent that only runs on demand. */
  trigger?: AgentTrigger
  defaults: InvocationDefaults
}

export interface InvocationOptions {
  floor?: number
  input?: JsonObject
  inputBindings?: InputBindings
  required?: boolean
  maxSteps?: number
  maxRetryAttempts?: number
  retryDelayMs?: number
  blocksNextTurn?: boolean
  toolResultMaxTokens?: number
  history?: HistoryPolicy
  saveAs?: ResultSlotPath
  apiPresetId?: string
  model?: string
  generationParameters?: GenerationParameters
  notification?: NotificationPolicy
  addendum?: string
}

export interface EffectiveInvocationOptions extends InvocationOptions {
  required: boolean
  maxSteps: number
  maxRetryAttempts: number
  retryDelayMs: number
  blocksNextTurn: boolean
  toolResultMaxTokens: number
  notification: NotificationPolicy
}

export interface InvocationPlanCall {
  agent: string
  input?: InputBindings
  required?: boolean
  maxSteps?: number
  maxRetryAttempts?: number
  retryDelayMs?: number
  blocksNextTurn?: boolean
  toolResultMaxTokens?: number
  history?: HistoryPolicy
  saveAs?: ResultSlotPath
  apiPresetId?: string
  model?: string
  generationParameters?: GenerationParameters
  notification?: NotificationPolicy
  addendum?: string
}

export interface InvocationPlanParallelGroup {
  parallel: InvocationPlanCall[]
}

export interface InvocationPlan {
  floor?: number
  steps: Array<InvocationPlanCall | InvocationPlanParallelGroup>
}

/** A live card implementation selected by name for an Agent-declared Tool Binding. */
export interface CardAgentToolBinding {
  name: string
  inputSchema: JsonSchema
  transactionMode: ToolTransactionMode
  parallelSafe: boolean
}

/** A state operation returned by a card Tool implementation for its Attempt Transaction. */
export interface CardAgentToolOperation {
  type: string
  payload: JsonObject
}

/** The structured result carried from a card Tool implementation back to the Harness. */
export interface CardAgentToolExecution {
  result: JsonValue
  operations?: CardAgentToolOperation[]
  externalEffectBegan?: boolean
}

export interface CardAgentToolContext {
  signal: AbortSignal
}

export type CardAgentToolHandler = (
  input: JsonObject,
  context: CardAgentToolContext
) => CardAgentToolExecution | Promise<CardAgentToolExecution>

/**
 * Card-supplied Agent Run options. `apiPresetId` and `model` are deliberately OMITTED: cards may never
 * choose the API preset or model — the user's per-Agent binding (or the profile's active preset) decides
 * (owner policy). The main-side Agent Host also strips these keys at runtime in case a card sends them
 * anyway, so this Omit is the visible half of a contract the transport enforces.
 */
export interface CardAgentRunOptions extends Omit<InvocationOptions, 'apiPresetId' | 'model'> {
  signal?: AbortSignal
}

/** The immutable snapshots supplied to card logic after a newly committed floor. */
export interface CardFloorCommit {
  floor: number
  variables: JsonObject
  previousVariables: JsonObject
}

/** Card-facing terminal outcome of one Agent Invocation. */
export type CardAgentRunOutcome =
  | {
      invocationId: string
      status: 'succeeded'
      result?: JsonValue
      sourceRestarts: number
      required: boolean
      processingWarnings?: AgentProcessingWarning[]
    }
  | {
      invocationId: string
      status: 'failed'
      failure: { code: string; message: string; retryable: boolean }
      sourceRestarts: number
      required: boolean
    }
  | {
      invocationId: string
      status: 'cancelled'
      sourceRestarts: number
      required: boolean
    }

/** Card-facing terminal outcome of a declarative Invocation Plan. */
export interface CardAgentPlanOutcome {
  planId: string
  status: 'succeeded' | 'failed' | 'cancelled'
  outcomes: CardAgentRunOutcome[]
}
