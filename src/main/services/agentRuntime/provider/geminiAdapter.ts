import { ProviderDispatchError } from './errors'
import { buildGeminiBody } from './shaping'
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

export const createGeminiAdapter = (
  providerFetch: ProviderFetch = globalThis.fetch
): ProviderAdapter => ({
  async dispatch(request, emit): Promise<void> {
    const base = (
      request.connection.endpoint || 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/$/, '')
    const url = `${base}/models/${encodeURIComponent(request.connection.model)}:streamGenerateContent?alt=sse`
    const response = await fetchProviderResponse(
      'Gemini API',
      providerFetch,
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': request.connection.apiKey
        },
        body: JSON.stringify(
          buildGeminiBody(request.messages, request.parameters, request.tools, request.toolChoice)
        ),
        signal: request.signal
      },
      request.signal
    )
    emitRateLimitHeaders(response, emit)

    let rawUsage: Record<string, any> | undefined
    let finishReason: unknown
    let sawOutput = false
    let toolCallIndex = 0
    let frameCount = 0
    let parsedFrameCount = 0
    await readSse(response, (data) => {
      frameCount++
      let payload: Record<string, any>
      try {
        payload = jsonRecord(JSON.parse(data))
      } catch {
        return
      }
      parsedFrameCount++
      const candidate = jsonRecord(payload.candidates?.[0])
      const parts = candidate.content?.parts
      if (Array.isArray(parts)) {
        parts.forEach((rawPart) => {
          const part = jsonRecord(rawPart)
          if (typeof part.text === 'string' && part.text) {
            sawOutput = true
            emit({
              type: part.thought === true ? 'reasoning-delta' : 'text-delta',
              delta: part.text
            })
          }
          if (part.functionCall) {
            const call = jsonRecord(part.functionCall)
            const index = toolCallIndex++
            sawOutput = true
            emit({
              type: 'tool-call-delta',
              index,
              id:
                typeof call.id === 'string'
                  ? call.id
                  : `gemini:${finiteNumberOrZero(candidate.index)}:${index}`,
              name: typeof call.name === 'string' ? call.name : undefined,
              input: call.args ?? {}
            })
          }
        })
      }
      if (payload.usageMetadata) rawUsage = jsonRecord(payload.usageMetadata)
      if (candidate.finishReason) finishReason = candidate.finishReason
    })
    if (!sawOutput && !request.signal?.aborted) {
      throw new ProviderDispatchError('Provider stream produced no model events', {
        retryClass: 'transient',
        diagnostics: {
          category: 'empty-stream',
          frameCount,
          parsedFrameCount
        }
      })
    }
    if (rawUsage) {
      const cached = finiteNumberOrZero(rawUsage.cachedContentTokenCount)
      emit({
        type: 'usage',
        usage: {
          inputTokens: Math.max(0, finiteNumberOrZero(rawUsage.promptTokenCount) - cached),
          outputTokens: finiteNumberOrZero(rawUsage.candidatesTokenCount)
        },
        cache: { readTokens: cached, writeTokens: 0 },
        raw: rawUsage
      })
    }
    emit({ type: 'finish', reason: mapFinishReason(finishReason) })
  }
})
