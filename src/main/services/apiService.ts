import { Settings } from '../types/models'
import { PresetParameters } from '../types/preset'
import { ChatMessage } from './promptBuilder'

/**
 * Call the configured provider and return the raw assistant text. Generation
 * parameters come from the active preset (preset wins over settings defaults).
 */
export const callProvider = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters
): Promise<string> => {
  if (settings.api.provider === 'anthropic') {
    return completeAnthropic(settings, messages, params)
  }
  return completeOpenAICompatible(settings, messages, params)
}

// Drop undefined params so we don't send nulls to providers that reject them.
const cleanParams = (params: PresetParameters): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

const completeOpenAICompatible = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters
): Promise<string> => {
  const { endpoint, api_key, model } = settings.api
  const base = endpoint || 'https://api.openai.com/v1'
  const url = base.endsWith('/chat/completions')
    ? base
    : `${base.replace(/\/$/, '')}/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api_key}`
    },
    body: JSON.stringify({ model, messages, ...cleanParams(params), stream: false })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content ?? ''
}

const completeAnthropic = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters
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
      stream: false
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Anthropic API Error: ${response.status} ${response.statusText} - ${errorText}`
    )
  }

  const data = await response.json()
  return data.content?.[0]?.text ?? ''
}
