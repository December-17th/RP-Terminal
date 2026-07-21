import { ProviderDispatchError } from './errors'
import { buildOpenAiBody } from './shaping'
import {
  emitRateLimitHeaders,
  fetchProviderResponse,
  finiteNumberOrZero,
  jsonRecord,
  mapFinishReason,
  readSse,
  type ProviderFetch
} from './transportUtils'
import type { ProviderAdapter, ProviderAdapterEvent } from './types'

const emitOpenAiUsage = (
  raw: Record<string, any>,
  emit: (event: ProviderAdapterEvent) => void
): void => {
  const cached = finiteNumberOrZero(raw.prompt_tokens_details?.cached_tokens)
  emit({
    type: 'usage',
    usage: {
      inputTokens: Math.max(0, finiteNumberOrZero(raw.prompt_tokens) - cached),
      outputTokens: finiteNumberOrZero(raw.completion_tokens)
    },
    cache: { readTokens: cached, writeTokens: 0 },
    raw
  })
}

const emitToolCalls = (calls: unknown, emit: (event: ProviderAdapterEvent) => void): void => {
  if (!Array.isArray(calls)) return
  calls.forEach((raw, fallbackIndex) => {
    const call = jsonRecord(raw)
    const fn = jsonRecord(call.function)
    emit({
      type: 'tool-call-delta',
      index: finiteNumberOrZero(call.index) || fallbackIndex,
      id: typeof call.id === 'string' ? call.id : undefined,
      name: typeof fn.name === 'string' ? fn.name : undefined,
      argumentsDelta: typeof fn.arguments === 'string' ? fn.arguments : undefined
    })
  })
}

export const createOpenAiAdapter = (
  providerFetch: ProviderFetch = globalThis.fetch
): ProviderAdapter => ({
  async dispatch(request, emit): Promise<void> {
    const base = request.connection.endpoint || 'https://api.openai.com/v1'
    const url = base.endsWith('/chat/completions')
      ? base
      : `${base.replace(/\/$/, '')}/chat/completions`
    const response = await fetchProviderResponse(
      'API',
      providerFetch,
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.connection.apiKey}`
        },
        body: JSON.stringify(buildOpenAiBody(request)),
        signal: request.signal
      },
      request.signal
    )
    emitRateLimitHeaders(response, emit)

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const rawText = await response.text()
      let payload: Record<string, any>
      try {
        payload = jsonRecord(JSON.parse(rawText))
      } catch {
        throw new ProviderDispatchError('Provider returned invalid non-streaming JSON', {
          retryClass: 'transient',
          diagnostics: { category: 'invalid-response' }
        })
      }
      const choice = jsonRecord(payload.choices?.[0])
      const message = jsonRecord(choice.message)
      const reasoning = message.reasoning_content ?? message.reasoning
      const content = message.content ?? choice.text
      const toolCalls = message.tool_calls
      if (
        !(typeof reasoning === 'string' && reasoning) &&
        !(typeof content === 'string' && content) &&
        !(Array.isArray(toolCalls) && toolCalls.length)
      ) {
        throw new ProviderDispatchError('Provider returned an empty completion', {
          retryClass: 'transient',
          diagnostics: { category: 'empty-completion' }
        })
      }
      if (typeof reasoning === 'string' && reasoning)
        emit({ type: 'reasoning-delta', delta: reasoning })
      if (typeof content === 'string' && content) emit({ type: 'text-delta', delta: content })
      emitToolCalls(toolCalls, emit)
      if (payload.usage) emitOpenAiUsage(jsonRecord(payload.usage), emit)
      emit({
        type: 'finish',
        reason: mapFinishReason(choice.finish_reason),
        delivery: 'non-streaming'
      })
      return
    }

    let finishReason: unknown
    let sawOutput = false
    let frameCount = 0
    let parsedFrameCount = 0
    const frameCategories = new Set<'choice' | 'error' | 'unknown' | 'usage'>()
    await readSse(response, (data) => {
      frameCount++
      let payload: Record<string, any>
      try {
        payload = jsonRecord(JSON.parse(data))
      } catch {
        return
      }
      parsedFrameCount++
      if (payload.error) frameCategories.add('error')
      else if (payload.usage) frameCategories.add('usage')
      else if (Array.isArray(payload.choices)) frameCategories.add('choice')
      else frameCategories.add('unknown')
      if (payload.usage) emitOpenAiUsage(jsonRecord(payload.usage), emit)
      const choice = jsonRecord(payload.choices?.[0])
      const delta = jsonRecord(choice.delta)
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning) {
        sawOutput = true
        emit({ type: 'reasoning-delta', delta: reasoning })
      }
      if (typeof delta.content === 'string' && delta.content) {
        sawOutput = true
        emit({ type: 'text-delta', delta: delta.content })
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) sawOutput = true
      emitToolCalls(delta.tool_calls, emit)
      if (choice.finish_reason) finishReason = choice.finish_reason
    })
    if (!sawOutput && !request.signal?.aborted) {
      throw new ProviderDispatchError('Provider stream produced no model events', {
        retryClass: 'transient',
        diagnostics: {
          category: 'empty-stream',
          frameCount,
          parsedFrameCount,
          frameCategories: [...frameCategories]
        }
      })
    }
    emit({ type: 'finish', reason: mapFinishReason(finishReason), delivery: 'stream' })
  }
})
