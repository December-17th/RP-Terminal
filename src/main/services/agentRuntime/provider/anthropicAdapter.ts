import { buildAnthropicBody } from './shaping'
import {
  emitRateLimitHeaders,
  fetchProviderResponse,
  finiteNumberOrZero,
  jsonRecord,
  mapFinishReason,
  readSse,
  type ProviderFetch
} from './transportUtils'
import type { ProviderAdapter } from './types'

export const createAnthropicAdapter = (
  providerFetch: ProviderFetch = globalThis.fetch
): ProviderAdapter => ({
  async dispatch(request, emit): Promise<void> {
    const base = request.connection.endpoint || 'https://api.anthropic.com/v1'
    const url = base.endsWith('/messages') ? base : `${base.replace(/\/$/, '')}/messages`
    const response = await fetchProviderResponse(
      'Anthropic API',
      providerFetch,
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': request.connection.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(buildAnthropicBody(request)),
        signal: request.signal
      },
      request.signal
    )
    emitRateLimitHeaders(response, emit)

    const usage: Record<string, any> = {}
    let rawUsage: Record<string, any> | undefined
    let finishReason: unknown
    await readSse(response, (data) => {
      let payload: Record<string, any>
      try {
        payload = jsonRecord(JSON.parse(data))
      } catch {
        return
      }
      if (payload.type === 'message_start' && payload.message?.usage) {
        Object.assign(usage, jsonRecord(payload.message.usage))
        rawUsage = usage
      }
      if (payload.type === 'message_delta') {
        if (payload.usage) {
          Object.assign(usage, jsonRecord(payload.usage))
          rawUsage = usage
        }
        finishReason = payload.delta?.stop_reason ?? finishReason
      }
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        const block = jsonRecord(payload.content_block)
        emit({
          type: 'tool-call-delta',
          index: finiteNumberOrZero(payload.index),
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          ...(block.input === undefined ? {} : { input: block.input })
        })
      }
      if (payload.type === 'content_block_delta') {
        const delta = jsonRecord(payload.delta)
        if (typeof delta.thinking === 'string' && delta.thinking)
          emit({ type: 'reasoning-delta', delta: delta.thinking })
        else if (typeof delta.text === 'string' && delta.text)
          emit({ type: 'text-delta', delta: delta.text })
        if (typeof delta.partial_json === 'string') {
          emit({
            type: 'tool-call-delta',
            index: finiteNumberOrZero(payload.index),
            argumentsDelta: delta.partial_json
          })
        }
      }
    })
    if (rawUsage) {
      emit({
        type: 'usage',
        usage: {
          inputTokens: finiteNumberOrZero(usage.input_tokens),
          outputTokens: finiteNumberOrZero(usage.output_tokens)
        },
        cache: {
          readTokens: finiteNumberOrZero(usage.cache_read_input_tokens),
          writeTokens: finiteNumberOrZero(usage.cache_creation_input_tokens)
        },
        raw: { ...usage }
      })
    }
    emit({ type: 'finish', reason: mapFinishReason(finishReason) })
  }
})
