import type {
  AgentDefinition,
  EffectiveInvocationOptions,
  JsonValue,
  PromptMessage
} from '../../../../shared/agentRuntime'
import type { ProviderMessage } from '../provider'
import type { HarnessExecuteRequest, HarnessFailure } from './types'

export type BuildAttemptLogResult =
  | { ok: true; immutablePrefix: ProviderMessage[]; attemptLog: ProviderMessage[] }
  | { ok: false; failure: HarnessFailure }

const resolvePromptMessage = (
  message: PromptMessage,
  request: HarnessExecuteRequest
): { ok: true; content: string } | { ok: false; binding: string } => {
  const chunks: string[] = []
  for (const segment of message.content) {
    if (segment.type === 'text') {
      chunks.push(segment.text)
      continue
    }
    const source = segment.source
    let value: JsonValue | undefined
    let key: string = source.type
    if (source.type === 'input') value = request.input
    else if (source.type === 'history') value = request.history
    else {
      key = source.path
      value = request.promptValues?.[source.path]
    }
    if (value === undefined) value = segment.default
    if (value === undefined) return { ok: false, binding: key }
    chunks.push(typeof value === 'string' ? value : JSON.stringify(value))
  }
  return { ok: true, content: chunks.join('') }
}

export const buildAttemptLog = (
  definition: AgentDefinition,
  request: HarnessExecuteRequest,
  options: EffectiveInvocationOptions,
  policy: string
): BuildAttemptLogResult => {
  const immutablePrefix: ProviderMessage[] = [{ role: 'system', content: policy }]
  const attemptLog: ProviderMessage[] = []
  let volatile = false
  for (const prompt of definition.prompt) {
    const rendered = resolvePromptMessage(prompt, request)
    if (!rendered.ok) {
      return {
        ok: false,
        failure: {
          code: 'PROMPT_BINDING_MISSING',
          message: `Prompt Binding "${rendered.binding}" is unavailable`,
          retryable: false
        }
      }
    }
    volatile ||= prompt.content.some((segment) => segment.type === 'binding')
    ;(volatile ? attemptLog : immutablePrefix).push({
      role: prompt.role,
      content: rendered.content
    })
  }
  attemptLog.push({ role: 'user', content: JSON.stringify(request.input) })
  if (options.addendum) attemptLog.push({ role: 'user', content: options.addendum })
  return { ok: true, immutablePrefix, attemptLog }
}
