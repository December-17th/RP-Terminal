import type { Settings } from '../types/models'
import type { PresetParameters } from '../types/preset'
import type { ChatMessage } from './promptBuilder'
import { log } from './logService'
import {
  createCompatibilityProviderDispatch,
  ordinaryGenerationHttpErrorMessage,
  providerEndpointKey,
  providerTransportFamilyFor,
  ProviderDispatchError,
  type ProviderConnection
} from './agentRuntime/provider'
import {
  buildAnthropicCacheLayout as buildProviderAnthropicCacheLayout,
  buildGeminiBody as buildProviderGeminiBody
} from './agentRuntime/provider/shaping'

export type DeltaCallback = (delta: string) => void

/** Receives the provider's raw usage object once known. */
export type UsageCallback = (raw: unknown) => void

const providerConnection = (settings: Settings): ProviderConnection => ({
  provider: settings.api.provider,
  endpoint: settings.api.endpoint,
  apiKey: settings.api.api_key,
  model: settings.api.model,
  rpmLimit: settings.api.rpm_limit,
  maxConcurrent: settings.api.max_concurrent,
  cacheMode: settings.cache?.mode ?? 'baseline'
})

/** The endpoint an API block actually sends to. Presets sharing it share one budget. */
export const rpmEndpointKey = (api: Settings['api']): string =>
  providerEndpointKey({
    provider: api.provider,
    endpoint: api.endpoint
  })

/**
 * Temporary ordinary-generation compatibility wrapper over ProviderDispatch.
 * Normalized reasoning is volatile; this legacy caller explicitly opts into its historical
 * `<think>...</think>` presentation and raw-usage callback.
 */
export const streamProvider = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback,
  signal?: AbortSignal,
  onUsage?: UsageCallback
): Promise<string> => {
  const assembler = thinkAssembler(onDelta)
  let sawReasoning = false
  let sawText = false
  const provider = createCompatibilityProviderDispatch(providerConnection(settings), params)
  const transport = providerTransportFamilyFor(settings.api.provider)
  let result
  try {
    result = await provider.dispatch({
      messages,
      signal,
      onEvent: (event) => {
        if (event.type === 'reasoning') {
          sawReasoning = true
          assembler.reasoning(event.delta)
        }
        if (event.type === 'text') {
          sawText = true
          assembler.content(event.delta)
        }
      }
    })
  } catch (cause) {
    if (
      signal?.aborted &&
      cause instanceof ProviderDispatchError &&
      cause.retryClass === 'cancelled'
    ) {
      return assembler.done()
    }
    if (cause instanceof ProviderDispatchError) {
      const compatibilityMessage = ordinaryGenerationHttpErrorMessage(cause)
      if (compatibilityMessage) throw new Error(compatibilityMessage)
      if (transport === 'openai-compatible' && cause.diagnostics?.category === 'empty-stream') {
        throw new Error('Stream produced no text')
      }
    }
    throw cause
  }
  let full = assembler.done()
  if (result.delivery === 'non-streaming' && sawReasoning && !sawText) {
    full += '\n\n'
    onDelta('\n\n')
  }
  if (result.rawUsage !== undefined) {
    onUsage?.(result.rawUsage)
    if (transport === 'anthropic') {
      log(
        'info',
        `cache — read ${result.cache?.readTokens ?? 0} · write ${result.cache?.writeTokens ?? 0} · fresh ${result.usage?.inputTokens ?? 0} tok`
      )
    }
    if (transport === 'gemini') {
      log(
        'info',
        `gemini — prompt ${(result.usage?.inputTokens ?? 0) + (result.cache?.readTokens ?? 0)} · output ${result.usage?.outputTokens ?? 0} · cached ${result.cache?.readTokens ?? 0} tok`
      )
    }
  }
  if (!full && !signal?.aborted && transport !== 'anthropic') {
    if (transport === 'gemini') {
      throw new Error('Gemini stream produced no text')
    }
    throw new Error('Stream produced no text')
  }
  return full
}

/** True for providers reached through the OpenAI-compatible chat-completions transport. */
export const isOpenAiCompatibleProvider = (provider?: string): boolean =>
  providerTransportFamilyFor(provider ?? '') === 'openai-compatible'

export const orderForProvider = (messages: ChatMessage[], provider?: string): ChatMessage[] => {
  if (!isOpenAiCompatibleProvider(provider)) return messages
  if (messages[messages.length - 1]?.role === 'assistant') return messages
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user')
  if (lastUserIndex === -1 || lastUserIndex === messages.length - 1) return messages
  return [
    ...messages.slice(0, lastUserIndex),
    ...messages.slice(lastUserIndex + 1),
    messages[lastUserIndex]
  ]
}

export const listModels = async (api: Settings['api']): Promise<string[]> => {
  const key = api.api_key || ''
  const collect = (rows: unknown, field: 'id' | 'name'): string[] =>
    (Array.isArray(rows) ? rows : [])
      .map((model) => (model as Record<string, unknown>)?.[field])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  const fail = async (response: Response): Promise<never> => {
    throw new Error(`models ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }

  const transport = providerTransportFamilyFor(api.provider)
  if (transport === 'anthropic') {
    const base = (api.endpoint || 'https://api.anthropic.com/v1').replace(/\/$/, '')
    const response = await fetch(`${base}/models?limit=1000`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    })
    if (!response.ok) return fail(response)
    return collect(((await response.json()) as { data?: unknown }).data, 'id')
  }
  if (transport === 'gemini') {
    const base = (api.endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      ''
    )
    const response = await fetch(`${base}/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': key }
    })
    if (!response.ok) return fail(response)
    return collect(((await response.json()) as { models?: unknown }).models, 'name').map((name) =>
      name.replace(/^models\//, '')
    )
  }
  const base = (api.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '')
  const response = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` }
  })
  if (!response.ok) return fail(response)
  return collect(((await response.json()) as { data?: unknown }).data, 'id')
}

type ThinkAssembler = {
  reasoning: (content: string) => void
  content: (content: string) => void
  done: () => string
}

export const thinkAssembler = (onDelta: DeltaCallback): ThinkAssembler => {
  let full = ''
  let open = false
  const push = (value: string): void => {
    full += value
    onDelta(value)
  }
  return {
    reasoning: (content) => {
      if (!content) return
      if (!open) {
        push('<think>')
        open = true
      }
      push(content)
    },
    content: (content) => {
      if (!content) return
      if (open) {
        push('</think>\n\n')
        open = false
      }
      push(content)
    },
    done: () => {
      if (open) {
        push('</think>')
        open = false
      }
      return full
    }
  }
}

export const buildAnthropicCacheLayout = (
  merged: ChatMessage[],
  systemPrompt: string,
  cacheOn: boolean
): { system: unknown; outMessages: unknown[] } =>
  buildProviderAnthropicCacheLayout(merged, systemPrompt, cacheOn)

export const buildGeminiBody = (
  messages: ChatMessage[],
  params: PresetParameters
): Record<string, unknown> => buildProviderGeminiBody(messages, params)
