import { Settings } from '../types/models'
import { PresetParameters } from '../types/preset'
import { ChatMessage } from './promptBuilder'

export type DeltaCallback = (delta: string) => void

/**
 * Stream a completion from the configured provider. Each text chunk is handed to
 * `onDelta` as it arrives; the full concatenated text is returned when done.
 * Generation parameters come from the active preset (preset wins over defaults).
 */
export const streamProvider = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback
): Promise<string> => {
  if (settings.api.provider === 'anthropic') {
    return streamAnthropic(settings, messages, params, onDelta)
  }
  return streamOpenAICompatible(settings, messages, params, onDelta)
}

// Drop undefined params so we don't send nulls to providers that reject them.
const cleanParams = (params: PresetParameters): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * Read an SSE body line by line, handing each `data:` payload (minus the prefix)
 * to `handle`. Buffers partial lines across chunks. `[DONE]` is filtered out.
 */
const readSse = async (
  response: Response,
  handle: (data: string) => void
): Promise<void> => {
  if (!response.body) throw new Error('No response body to stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // keep the trailing partial line
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data && data !== '[DONE]') handle(data)
    }
  }
}

const streamOpenAICompatible = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback
): Promise<string> => {
  const { endpoint, api_key, model } = settings.api
  const base = endpoint || 'https://api.openai.com/v1'
  const url = base.endsWith('/chat/completions')
    ? base
    : `${base.replace(/\/$/, '')}/chat/completions`

  // Strict backends (e.g. Claude via a Bedrock/OpenAI-compat proxy) require the
  // conversation to END with a user message and reject a trailing assistant
  // "prefill". Presets routinely place jailbreak/post-history blocks *after* the
  // user's turn, so move the last user message to the very end — trailing
  // system/assistant blocks slide just before it. Content is preserved and the
  // request ends on a user turn.
  let outMessages = messages
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
  if (lastUserIdx !== -1 && lastUserIdx !== messages.length - 1) {
    outMessages = [
      ...messages.slice(0, lastUserIdx),
      ...messages.slice(lastUserIdx + 1),
      messages[lastUserIdx]
    ]
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api_key}`
    },
    body: JSON.stringify({ model, messages: outMessages, ...cleanParams(params), stream: true })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`)
  }

  // Some OpenAI-compatible proxies ignore stream:true and return a normal JSON
  // completion. Fall back to parsing that instead of silently yielding nothing.
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text()
    let content = ''
    try {
      const json = JSON.parse(text)
      content = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? ''
    } catch {
      throw new Error(`Non-streaming response was not valid JSON: ${text.slice(0, 800)}`)
    }
    if (!content) throw new Error(`Provider returned an empty completion: ${text.slice(0, 800)}`)
    onDelta(content)
    return content
  }

  let full = ''
  const rawFrames: string[] = []
  await readSse(response, (data) => {
    rawFrames.push(data)
    try {
      const json = JSON.parse(data)
      const delta = json.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) {
        full += delta
        onDelta(delta)
      }
    } catch {
      // ignore keep-alive / non-JSON lines
    }
  })
  if (!full) {
    throw new Error(
      `Stream produced no text. Raw frames:\n${rawFrames.slice(0, 8).join('\n').slice(0, 800) || '(none)'}`
    )
  }
  return full
}

const streamAnthropic = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback
): Promise<string> => {
  const { endpoint, api_key, model } = settings.api
  const base = endpoint || 'https://api.anthropic.com/v1'
  const url = base.endsWith('/messages') ? base : `${base.replace(/\/$/, '')}/messages`

  // Anthropic takes the system prompt at the top level and requires alternating
  // user/assistant roles, so hoist system messages and merge same-role runs.
  let systemPrompt = ''
  const convo = messages.filter((m) => {
    if (m.role === 'system') {
      systemPrompt += m.content + '\n'
      return false
    }
    return true
  })

  const merged: ChatMessage[] = []
  for (const msg of convo) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.content += '\n\n' + msg.content
    } else {
      merged.push({ ...msg })
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': api_key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-opus-4-8',
      system: systemPrompt.trim() || undefined,
      messages: merged,
      max_tokens: params.max_tokens ?? 4000,
      temperature: params.temperature ?? 0.9,
      ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
      ...(params.top_k !== undefined ? { top_k: params.top_k } : {}),
      stream: true
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Anthropic API Error: ${response.status} ${response.statusText} - ${errorText}`
    )
  }

  let full = ''
  await readSse(response, (data) => {
    try {
      const json = JSON.parse(data)
      // content_block_delta carries incremental text_delta chunks.
      if (json.type === 'content_block_delta' && typeof json.delta?.text === 'string') {
        full += json.delta.text
        onDelta(json.delta.text)
      }
    } catch {
      // ignore non-JSON lines
    }
  })
  return full
}
