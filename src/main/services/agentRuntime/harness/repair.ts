import type { ProviderResult, ProviderToolCall } from '../provider'
import type { ToolBinding } from '../tools'
export { canonicalJson } from '../internal/json'

export const closeTruncatedJson = (
  text: string
): { ok: true; text: string; value: unknown; repaired: boolean } | { ok: false } => {
  try {
    return { ok: true, text, value: JSON.parse(text), repaired: false }
  } catch {
    // Continue only when the prefix is structurally unambiguous.
  }
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') stack.push('}')
    else if (character === '[') stack.push(']')
    else if (character === '}' || character === ']') {
      if (stack.pop() !== character) return { ok: false }
    }
  }
  if (!stack.length && !inString) return { ok: false }
  const repairedText = `${text}${inString && !escaped ? '"' : ''}${stack.reverse().join('')}`
  try {
    return {
      ok: true,
      text: repairedText,
      value: JSON.parse(repairedText),
      repaired: true
    }
  } catch {
    return { ok: false }
  }
}

export const callsFromWrongChannel = (
  result: ProviderResult,
  bindings: Map<string, ToolBinding>,
  source: 'visible-result' | 'reasoning'
): ProviderToolCall[] => {
  if (result.toolCalls.length || !result.text.trim()) return result.toolCalls
  const parsed = closeTruncatedJson(result.text.trim())
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return []
  const record = parsed.value as Record<string, unknown>
  const explicitlyWrapped = Array.isArray(record.tool_calls) || Object.hasOwn(record, 'tool_call')
  const rawCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : record.tool_call
      ? [record.tool_call]
      : source === 'reasoning' && typeof record.name === 'string'
        ? [record]
        : []
  if (source === 'visible-result' && !explicitlyWrapped) return []
  return rawCalls.flatMap((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return []
    const call = raw as Record<string, unknown>
    const nested =
      typeof call.function === 'object' && call.function !== null
        ? (call.function as Record<string, unknown>)
        : call
    const name = typeof nested.name === 'string' ? nested.name : ''
    if (!bindings.has(name)) return []
    if (!Object.hasOwn(nested, 'arguments') && !Object.hasOwn(nested, 'input')) return []
    const input = nested.arguments ?? nested.input
    const argumentsText = typeof input === 'string' ? input : JSON.stringify(input)
    if (argumentsText === undefined) return []
    return [
      {
        id: typeof call.id === 'string' ? call.id : `repaired:${index}`,
        name,
        argumentsText,
        ...(typeof input === 'string' ? {} : { input })
      }
    ]
  })
}
