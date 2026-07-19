import type { PresetParameters } from '../../../types/preset'

export type ProviderTransportFamily = 'openai-compatible' | 'anthropic' | 'gemini'
export type ProviderCapabilityProfileId =
  | 'openai-compatible'
  | 'deepseek-compatible'
  | 'anthropic'
  | 'gemini'

export interface ProviderConnection {
  provider: string
  endpoint: string
  apiKey: string
  model: string
  rpmLimit?: number
  maxConcurrent?: number
  cacheMode?: 'baseline' | 'provider' | 'frozen'
}

export interface ProviderSelection {
  profileId: string
  apiPresetId?: string
  model?: string
  /**
   * ADR 0021 §2: the bundled preset's own parameter overrides. Exactly ONE layer, sitting directly
   * ABOVE the resolved API preset's parameters and BELOW `generationParameters` — an Agent that ships
   * `temperature: 0.2` in its bundle is still overridable per invocation.
   */
  presetBundleParameters?: Partial<PresetParameters>
  generationParameters?: Partial<PresetParameters>
}

export interface ProviderPresetSnapshot {
  id: string
  name: string
  provider: string
  endpoint: string
  model: string
  rpmLimit?: number
  maxConcurrent?: number
  cacheMode: 'baseline' | 'provider' | 'frozen'
  contextWindowTokens: number
  parameters: Readonly<PresetParameters>
}

export interface ProviderCapabilityProfile {
  id: ProviderCapabilityProfileId
  transport: ProviderTransportFamily
  toolSchema: 'json-schema' | 'gemini-subset'
  supportsTools: boolean
  supportsReasoningChannel: boolean
  supportsCacheMetrics: boolean
  supportsWrongChannelToolRepair: boolean
  supportsTruncatedJsonRepair: boolean
  defaultContextWindowTokens: number
}

export interface ProviderToolCall {
  id: string
  name: string
  argumentsText: string
  input?: unknown
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
  toolCalls?: ProviderToolCall[]
}

export interface ProviderToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
}

export interface ProviderCacheUsage {
  readTokens: number
  writeTokens: number
}

export interface ProviderRateLimit {
  requestsLimit?: number
  requestsRemaining?: number
  tokensLimit?: number
  tokensRemaining?: number
  resetAfterMs?: number
  retryAfterMs?: number
}

export type ProviderFinishReason =
  | 'stop'
  | 'tool-calls'
  | 'length'
  | 'content-filter'
  | 'cancelled'
  | 'other'

export type ProviderResponseDelivery = 'stream' | 'non-streaming'

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string; volatile: true }
  | { type: 'tool-call'; toolCall: ProviderToolCall }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'cache'; cache: ProviderCacheUsage }
  | { type: 'rate-limit'; rateLimit: ProviderRateLimit }
  | {
      type: 'completion'
      reason: ProviderFinishReason
      text: string
      toolCalls: ProviderToolCall[]
    }

export interface ProviderCallRequest {
  messages: ProviderMessage[]
  tools?: ProviderToolDefinition[]
  toolChoice?: 'auto' | 'required' | 'none'
  signal?: AbortSignal
  onEvent?: (event: ProviderEvent) => void
}

export interface ProviderResult {
  capability: ProviderCapabilityProfile
  text: string
  toolCalls: ProviderToolCall[]
  usage?: ProviderUsage
  cache?: ProviderCacheUsage
  rateLimit?: ProviderRateLimit
  finishReason: ProviderFinishReason
  delivery: ProviderResponseDelivery
  /** Retained only for the temporary ordinary-generation usage callback. */
  rawUsage?: unknown
}

export type ProviderRetryClass = 'transient' | 'rate-limit' | 'non-retryable' | 'cancelled'

export interface ProviderErrorDiagnostics {
  category:
    | 'cancelled'
    | 'empty-completion'
    | 'empty-stream'
    | 'http'
    | 'invalid-response'
    | 'transport'
  frameCount?: number
  parsedFrameCount?: number
  frameCategories?: Array<'choice' | 'error' | 'unknown' | 'usage'>
}

export type ProviderAdapterEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | {
      type: 'tool-call-delta'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
      input?: unknown
    }
  | {
      type: 'usage'
      usage: ProviderUsage
      cache: ProviderCacheUsage
      raw: unknown
    }
  | { type: 'rate-limit'; rateLimit: ProviderRateLimit }
  | {
      type: 'finish'
      reason: ProviderFinishReason
      delivery?: ProviderResponseDelivery
    }

export interface NormalizedProviderRequest {
  connection: Readonly<ProviderConnection>
  capability: Readonly<ProviderCapabilityProfile>
  messages: readonly Readonly<ProviderMessage>[]
  parameters: Readonly<PresetParameters>
  tools: readonly Readonly<ProviderToolDefinition>[]
  toolChoice: 'auto' | 'required' | 'none'
  signal?: AbortSignal
}

export interface ProviderAdapter {
  dispatch(
    request: NormalizedProviderRequest,
    emit: (event: ProviderAdapterEvent) => void
  ): Promise<void>
}

export interface ProviderDispatch {
  resolve(selection: ProviderSelection): ResolvedProviderDispatch
}

export interface ResolvedProviderDispatch {
  readonly preset: Readonly<ProviderPresetSnapshot>
  readonly capability: Readonly<ProviderCapabilityProfile>
  dispatch(request: ProviderCallRequest): Promise<ProviderResult>
}
