import type { PresetParameters } from '../../../types/preset'
import type { NormalizedProviderRequest, ProviderMessage, ProviderToolDefinition } from './types'

const cleanParameters = (parameters: PresetParameters): Record<string, unknown> => {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) clean[key] = value
  }
  return clean
}

const openAiMessage = (message: ProviderMessage): Record<string, unknown> => {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      ...(message.name ? { name: message.name } : {})
    }
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.argumentsText }
          }))
        }
      : {})
  }
}

export const buildOpenAiBody = (request: NormalizedProviderRequest): Record<string, unknown> => ({
  model: request.connection.model,
  messages: request.messages.map(openAiMessage),
  ...cleanParameters(request.parameters),
  ...(request.tools.length
    ? {
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        })),
        tool_choice: request.toolChoice
      }
    : {}),
  stream: true,
  stream_options: { include_usage: true }
})

export const buildAnthropicCacheLayout = (
  merged: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  cacheOn: boolean
): { system: unknown; outMessages: unknown[] } => {
  const ephemeral = { type: 'ephemeral' as const }
  const systemText = systemPrompt.trim()
  const system = systemText
    ? cacheOn
      ? [{ type: 'text', text: systemText, cache_control: ephemeral }]
      : systemText
    : undefined
  if (!cacheOn) return { system, outMessages: merged }
  const cacheIndex = merged.length - 2
  const outMessages = merged.map((message, index) =>
    index === cacheIndex && typeof message.content === 'string'
      ? {
          role: message.role,
          content: [{ type: 'text', text: message.content, cache_control: ephemeral }]
        }
      : message
  )
  return { system, outMessages }
}

const anthropicContent = (message: ProviderMessage): unknown => {
  if (message.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content
      }
    ]
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...message.toolCalls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input ?? safeParse(call.argumentsText)
      }))
    ]
  }
  return message.content
}

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

const geminiToolResponse = (content: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === 'object' ? parsed : { result: parsed }
  } catch {
    return { result: content }
  }
}

const mergeAnthropicMessages = (
  messages: readonly Readonly<ProviderMessage>[]
): { systemPrompt: string; messages: Array<{ role: 'user' | 'assistant'; content: unknown }> } => {
  let systemPrompt = ''
  let conversationStarted = false
  const shaped: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const message of messages) {
    if (message.role === 'system' && !conversationStarted) {
      systemPrompt += `${message.content}\n`
      continue
    }
    conversationStarted = true
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = anthropicContent(
      message.role === 'system' ? { role: 'user', content: message.content } : message
    )
    const prior = shaped[shaped.length - 1]
    if (prior?.role === role) {
      if (typeof prior.content === 'string' && typeof content === 'string') {
        prior.content += `\n\n${content}`
      } else {
        const blocks = (value: unknown): unknown[] =>
          Array.isArray(value) ? value : [{ type: 'text', text: String(value) }]
        const combined = [...blocks(prior.content), ...blocks(content)]
        prior.content =
          role === 'user'
            ? [
                ...combined.filter(
                  (block) =>
                    block &&
                    typeof block === 'object' &&
                    (block as Record<string, unknown>).type === 'tool_result'
                ),
                ...combined.filter(
                  (block) =>
                    !block ||
                    typeof block !== 'object' ||
                    (block as Record<string, unknown>).type !== 'tool_result'
                )
              ]
            : combined
      }
    } else {
      shaped.push({ role, content })
    }
  }
  return { systemPrompt, messages: shaped }
}

export const buildAnthropicBody = (request: NormalizedProviderRequest): Record<string, unknown> => {
  const shaped = mergeAnthropicMessages(request.messages)
  const { system, outMessages } = buildAnthropicCacheLayout(
    shaped.messages,
    shaped.systemPrompt,
    request.connection.cacheMode !== 'baseline'
  )
  return {
    model: request.connection.model,
    system,
    messages: outMessages,
    max_tokens: request.parameters.max_tokens ?? 4000,
    temperature: request.parameters.temperature ?? 0.9,
    ...(request.parameters.top_p !== undefined ? { top_p: request.parameters.top_p } : {}),
    ...(request.parameters.top_k !== undefined ? { top_k: request.parameters.top_k } : {}),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema
          })),
          tool_choice:
            request.toolChoice === 'required'
              ? { type: 'any' }
              : { type: request.toolChoice === 'none' ? 'none' : 'auto' }
        }
      : {}),
    stream: true
  }
}

export const buildGeminiBody = (
  messages: readonly Readonly<ProviderMessage>[],
  parameters: PresetParameters,
  tools: readonly ProviderToolDefinition[] = [],
  toolChoice: 'auto' | 'required' | 'none' = 'auto'
): Record<string, unknown> => {
  let systemText = ''
  let conversationStarted = false
  const conversation: Array<{ role: 'user' | 'model'; parts: unknown[] }> = []
  for (const message of messages) {
    if (message.role === 'system' && !conversationStarted) {
      systemText += `${message.content}\n`
      continue
    }
    conversationStarted = true
    const parts: unknown[] =
      message.role === 'tool'
        ? [
            {
              functionResponse: {
                name: message.name ?? '',
                response: geminiToolResponse(message.content)
              }
            }
          ]
        : [
            ...(!message.toolCalls?.length || message.content ? [{ text: message.content }] : []),
            ...(message.role === 'assistant'
              ? (message.toolCalls ?? []).map((call) => ({
                  functionCall: {
                    name: call.name,
                    args: call.input ?? safeParse(call.argumentsText)
                  }
                }))
              : [])
          ]
    conversation.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts
    })
  }
  const merged: Array<{ role: 'user' | 'model'; parts: unknown[] }> = []
  for (const item of conversation) {
    const prior = merged[merged.length - 1]
    if (
      prior?.role === item.role &&
      prior.parts.every((part) => (part as Record<string, unknown>).text !== undefined) &&
      item.parts.every((part) => (part as Record<string, unknown>).text !== undefined)
    ) {
      const priorText = prior.parts.map((part) => (part as { text: string }).text).join('\n\n')
      const itemText = item.parts.map((part) => (part as { text: string }).text).join('\n\n')
      prior.parts = [{ text: `${priorText}\n\n${itemText}` }]
    } else if (prior?.role === item.role) {
      prior.parts.push(...item.parts)
    } else {
      merged.push({ role: item.role, parts: [...item.parts] })
    }
  }

  const generationConfig: Record<string, unknown> = {}
  if (parameters.temperature !== undefined) generationConfig.temperature = parameters.temperature
  if (parameters.max_tokens !== undefined) generationConfig.maxOutputTokens = parameters.max_tokens
  if (parameters.top_p !== undefined) generationConfig.topP = parameters.top_p
  if (parameters.top_k !== undefined) generationConfig.topK = parameters.top_k
  if (parameters.frequency_penalty !== undefined)
    generationConfig.frequencyPenalty = parameters.frequency_penalty
  if (parameters.presence_penalty !== undefined)
    generationConfig.presencePenalty = parameters.presence_penalty

  const body: Record<string, unknown> = {
    contents: merged,
    generationConfig
  }
  if (systemText.trim()) body.systemInstruction = { parts: [{ text: systemText.trim() }] }
  if (tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }))
      }
    ]
    body.toolConfig = {
      functionCallingConfig: {
        mode: toolChoice === 'required' ? 'ANY' : toolChoice === 'none' ? 'NONE' : 'AUTO'
      }
    }
  }
  return body
}
