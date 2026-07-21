import type { JsonValue } from '../../../../shared/agentRuntime'

export const projectToolResult = (
  result: JsonValue,
  maxTokens: number,
  estimateTokens: (content: string) => number
): { content: string; tokens: number; truncated: boolean } => {
  const full = JSON.stringify(result)
  if (estimateTokens(full) <= maxTokens) {
    return { content: full, tokens: estimateTokens(full), truncated: false }
  }
  let low = 0
  let high = full.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(full.slice(0, middle)) <= maxTokens) low = middle
    else high = middle - 1
  }
  const content = full.slice(0, low)
  return { content, tokens: estimateTokens(content), truncated: true }
}
