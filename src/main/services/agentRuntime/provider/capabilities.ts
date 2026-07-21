import type { ProviderCapabilityProfile, ProviderConnection, ProviderToolDefinition } from './types'

export const providerTransportFamilyFor = (
  providerInput: string
): ProviderCapabilityProfile['transport'] => {
  const provider = providerInput.toLowerCase()
  if (provider === 'anthropic') return 'anthropic'
  if (provider === 'google' || provider === 'gemini') return 'gemini'
  return 'openai-compatible'
}

export const defaultProviderEndpoint = (provider: string): string => {
  const transport = providerTransportFamilyFor(provider)
  if (transport === 'anthropic') return 'https://api.anthropic.com/v1'
  if (transport === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta'
  return 'https://api.openai.com/v1'
}

export const resolveProviderModel = (provider: string, model: string): string => {
  if (model) return model
  const transport = providerTransportFamilyFor(provider)
  if (transport === 'anthropic') return 'claude-opus-4-8'
  if (transport === 'gemini') return 'gemini-2.5-flash'
  return model
}

export const capabilityProfileFor = (connection: ProviderConnection): ProviderCapabilityProfile => {
  const provider = connection.provider.toLowerCase()
  const transport = providerTransportFamilyFor(provider)
  if (transport === 'anthropic') {
    return {
      id: 'anthropic',
      transport: 'anthropic',
      toolSchema: 'json-schema',
      supportsTools: true,
      supportsReasoningChannel: true,
      supportsCacheMetrics: true,
      supportsWrongChannelToolRepair: false,
      supportsTruncatedJsonRepair: true,
      defaultContextWindowTokens: 200_000
    }
  }
  if (transport === 'gemini') {
    return {
      id: 'gemini',
      transport: 'gemini',
      toolSchema: 'gemini-subset',
      supportsTools: true,
      supportsReasoningChannel: true,
      supportsCacheMetrics: true,
      supportsWrongChannelToolRepair: false,
      supportsTruncatedJsonRepair: true,
      defaultContextWindowTokens: 200_000
    }
  }
  const deepseek =
    provider === 'deepseek' ||
    connection.model.toLowerCase().includes('deepseek') ||
    connection.endpoint.toLowerCase().includes('deepseek')
  return {
    id: deepseek ? 'deepseek-compatible' : 'openai-compatible',
    transport: 'openai-compatible',
    toolSchema: 'json-schema',
    supportsTools: true,
    supportsReasoningChannel: true,
    supportsCacheMetrics: true,
    supportsWrongChannelToolRepair: deepseek,
    supportsTruncatedJsonRepair: true,
    defaultContextWindowTokens: 200_000
  }
}

const normalizeGeminiSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeGeminiSchema)
  if (!value || typeof value !== 'object') return value
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(input)) {
    if (key === '$schema' || key === '$id' || key === 'additionalProperties') continue
    if (key === 'const') {
      output.enum = [normalizeGeminiSchema(child)]
      continue
    }
    output[key] = normalizeGeminiSchema(child)
  }
  return output
}

export const normalizeTools = (
  tools: readonly ProviderToolDefinition[],
  capability: ProviderCapabilityProfile
): ProviderToolDefinition[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema:
      capability.toolSchema === 'gemini-subset'
        ? (normalizeGeminiSchema(tool.inputSchema) as Record<string, unknown>)
        : structuredClone(tool.inputSchema)
  }))
