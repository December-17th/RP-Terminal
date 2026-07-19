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
  | { mode: 'text'; saveAs?: ResultSlotPath; validator?: 'yss' }
  | { mode: 'json'; schema: JsonSchema; saveAs?: ResultSlotPath }
  | { mode: 'tools-only' }

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

export type NotificationPolicy = 'none' | 'failure' | 'completion'

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
  formatVersion: 1
  name: string
  description?: string
  prompt: PromptMessage[]
  inputSchema: JsonSchema
  result: ResultContract
  tools: AgentToolDefinition[]
  modelHint?: string
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
