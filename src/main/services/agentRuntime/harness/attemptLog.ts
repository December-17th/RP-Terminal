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

/**
 * Apply the injected prompt renderer, guarding the Harness against a renderer that throws or returns
 * a non-string. Prompt rendering must never take down an invocation (ADR 0021), so every failure
 * degrades to the authored text.
 */
const renderText = (text: string, render: ((text: string) => string) | undefined): string => {
  if (!render) return text
  try {
    const rendered = render(text)
    return typeof rendered === 'string' ? rendered : text
  } catch {
    return text
  }
}

const resolvePromptMessage = (
  message: PromptMessage,
  request: HarnessExecuteRequest,
  render: ((text: string) => string) | undefined
): { ok: true; content: string } | { ok: false; binding: string } => {
  const chunks: string[] = []
  for (const segment of message.content) {
    if (segment.type === 'text') {
      // ADR 0021: the AUTHORED text evaluates through the injected renderer (ST-Prompt-Template EJS
      // + macros). Bound values below deliberately do NOT — upstream data must never become
      // executable template code. Fail-open: a renderer that throws yields the raw text.
      chunks.push(renderText(segment.text, render))
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
  // ADR 0021: an upstream-assembled prompt SUBSTITUTES for the definition's own messages. It already
  // ends with those messages (the preset assembles context, `prompt` is the task instruction), so
  // nothing is lost by not reading `definition.prompt` here.
  //
  // An assembled prompt is also never re-rendered: the assembler already ran the engine over it, and
  // a second pass would treat card/lore/history CONTENT as template code. Enforced structurally here
  // rather than left to the caller to remember.
  const render = request.prompt ? undefined : request.render
  for (const prompt of request.prompt ?? definition.prompt) {
    const rendered = resolvePromptMessage(prompt, request, render)
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
    // VOLATILITY TRAP (ADR 0021): only a `binding` segment marks a message volatile. A rendered TEXT
    // segment also reads mutable state (`getvar`/`getMessageVar`) yet lands in the immutable prefix.
    // Harmless today — nothing reuses the prefix across calls, the split is flattened at dispatch, and
    // Anthropic cache_control is placed positionally (provider/shaping.ts). But the design's
    // "the Harness does not rebuild earlier bytes" prefix reuse (docs/agent-system/agent-runtime-design.md
    // §229-236) is UNIMPLEMENTED; whoever implements it must first treat templated text as volatile,
    // or a stale prefix will be replayed. Do not reclassify here casually — it reorders messages.
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
