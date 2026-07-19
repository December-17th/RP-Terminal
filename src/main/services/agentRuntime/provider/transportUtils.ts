import { providerHttpError, ProviderDispatchError, parseRetryAfterMs } from './errors'
import type { ProviderAdapterEvent, ProviderFinishReason, ProviderRateLimit } from './types'

export type ProviderFetch = typeof fetch

export const fetchProviderResponse = async (
  label: string,
  providerFetch: ProviderFetch,
  input: RequestInfo | URL,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> => {
  let response: Response
  try {
    response = await providerFetch(input, init)
  } catch {
    throw new ProviderDispatchError(
      signal?.aborted ? 'Provider request cancelled' : 'Provider request failed',
      {
        retryClass: signal?.aborted ? 'cancelled' : 'transient',
        diagnostics: { category: signal?.aborted ? 'cancelled' : 'transport' }
      }
    )
  }
  if (!response.ok) throw await providerHttpError(label, response)
  return response
}

export const finiteNumberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

export const readSse = async (
  response: Response,
  handle: (data: string) => void
): Promise<void> => {
  if (!response.body) {
    throw new ProviderDispatchError('No response body to stream', { retryClass: 'transient' })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data && data !== '[DONE]') handle(data)
    }
  }
  const trailing = buffer.trim()
  if (trailing.startsWith('data:')) {
    const data = trailing.slice(5).trim()
    if (data && data !== '[DONE]') handle(data)
  }
}

const finite = (value: string | null): number | undefined => {
  if (value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const durationMs = (value: string | null): number | undefined => {
  if (!value) return undefined
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = match[2]?.toLowerCase()
  return amount * (unit === 'm' ? 60_000 : unit === 'ms' ? 1 : 1000)
}

export const rateLimitFromHeaders = (headers: Headers): ProviderRateLimit | undefined => {
  const rateLimit: ProviderRateLimit = {
    requestsLimit: finite(
      headers.get('x-ratelimit-limit-requests') ?? headers.get('anthropic-ratelimit-requests-limit')
    ),
    requestsRemaining: finite(
      headers.get('x-ratelimit-remaining-requests') ??
        headers.get('anthropic-ratelimit-requests-remaining')
    ),
    tokensLimit: finite(
      headers.get('x-ratelimit-limit-tokens') ?? headers.get('anthropic-ratelimit-tokens-limit')
    ),
    tokensRemaining: finite(
      headers.get('x-ratelimit-remaining-tokens') ??
        headers.get('anthropic-ratelimit-tokens-remaining')
    ),
    resetAfterMs:
      durationMs(headers.get('x-ratelimit-reset-requests')) ??
      durationMs(headers.get('anthropic-ratelimit-requests-reset')),
    retryAfterMs: parseRetryAfterMs(headers.get('retry-after'))
  }
  return Object.values(rateLimit).some((value) => value !== undefined) ? rateLimit : undefined
}

export const emitRateLimitHeaders = (
  response: Response,
  emit: (event: ProviderAdapterEvent) => void
): void => {
  const rateLimit = rateLimitFromHeaders(response.headers)
  if (rateLimit) emit({ type: 'rate-limit', rateLimit })
}

export const mapFinishReason = (reason: unknown): ProviderFinishReason => {
  const value = typeof reason === 'string' ? reason.toLowerCase() : ''
  if (value === 'stop' || value === 'end_turn' || value === 'stop_sequence') return 'stop'
  if (value === 'tool_calls' || value === 'tool_use') return 'tool-calls'
  if (value === 'length' || value === 'max_tokens' || value === 'max_tokens_reached')
    return 'length'
  if (value.includes('safety') || value.includes('content_filter')) return 'content-filter'
  return value ? 'other' : 'stop'
}

export const jsonRecord = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' ? (value as Record<string, any>) : {}
