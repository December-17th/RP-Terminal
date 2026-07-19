import type { ProviderMessage, ProviderToolDefinition } from '../provider'
import { estimateTokens } from '../../promptBudget'
import type { ContextBudgetAttribution, HarnessExecuteRequest } from './types'

export const defaultEstimateTokens = estimateTokens

export const contextAttribution = (
  _request: HarnessExecuteRequest,
  immutablePrefix: ProviderMessage[],
  attemptLog: ProviderMessage[],
  tools: ProviderToolDefinition[],
  estimate: (content: string) => number,
  outputReserveTokens: number,
  contextWindowTokens: number
): ContextBudgetAttribution => {
  const regions: ContextBudgetAttribution['regions'] = []
  const add = (region: string, content: string): void => {
    regions.push({ region, tokens: estimate(content) })
  }
  const messages = [...immutablePrefix, ...attemptLog]
  immutablePrefix.forEach((message, index) => {
    add(index === 0 ? 'harness-policy' : `immutable-prompt:${index}`, message.content)
  })
  attemptLog.forEach((message, index) => {
    const region =
      message.role === 'tool'
        ? `tool-result:${message.toolCallId ?? index}`
        : `attempt-log:${index}`
    add(region, message.content)
  })
  regions.push({ region: 'message-overhead', tokens: messages.length * 4 })
  messages.forEach((message, messageIndex) => {
    if (message.name) add(`message-name:${messageIndex}`, message.name)
    message.toolCalls?.forEach((call, callIndex) => {
      add(`tool-call-name:${messageIndex}:${callIndex}`, call.name)
      add(`tool-call-arguments:${messageIndex}:${callIndex}`, call.argumentsText)
    })
  })
  tools.forEach((tool) => {
    add(`tool-name:${tool.name}`, tool.name)
    add(`tool-description:${tool.name}`, tool.description)
    add(`tool-schema:${tool.name}`, JSON.stringify(tool.inputSchema))
  })
  regions.push({ region: 'output-reserve', tokens: outputReserveTokens })
  return {
    limit: contextWindowTokens,
    total: regions.reduce((sum, region) => sum + region.tokens, 0),
    regions
  }
}
